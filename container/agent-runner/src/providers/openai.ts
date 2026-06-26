import { randomUUID } from 'crypto';

import { registerProvider } from './provider-registry.js';
import { loadHistory, saveHistory, historyMissing, type ChatTurn } from './chat-history.js';
import { proxyOption, isRetryable, sseLines } from './provider-http.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI chat-completions provider. Text-in/text-out: it streams the model's
 * reply and lets the poll-loop dispatch any `<message to="…">` blocks the model
 * emits. It has no native tool loop — the agent talks, the loop delivers.
 *
 * Auth goes through the OneCLI gateway exactly like the Claude path: we send a
 * placeholder bearer token and the proxy rewrites the Authorization header on
 * the wire. Set OPENAI_API_KEY only if running without the gateway.
 */
export class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly usesMemoryScaffold = true;

  private model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model || options.env?.OPENAI_MODEL || DEFAULT_MODEL;
    this.baseUrl = (options.env?.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.env?.OPENAI_API_KEY || 'placeholder';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /history missing/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation && historyMissing(input.continuation)) {
      // Surface to the poll-loop so it clears the stale continuation and retries.
      const events: AsyncIterable<ProviderEvent> = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'activity' };
          throw new Error(`history missing for ${input.continuation}`);
        },
      };
      return { push() {}, end() {}, events, abort() {} };
    }

    const continuation = input.continuation || `openai-${randomUUID()}`;
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const self = this;
    const instructions = input.systemContext?.instructions;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation };

        const history = loadHistory(input.continuation);

        let next: string | null = input.prompt;
        while (next !== null) {
          if (aborted) return;
          history.push({ role: 'user', content: next });
          yield { type: 'activity' };

          let assistantText = '';
          try {
            for await (const ev of self.streamCompletion(history, instructions)) {
              if (aborted) return;
              if (ev.kind === 'delta') {
                assistantText += ev.text;
                yield { type: 'activity' };
              } else {
                yield { type: 'progress', message: ev.text };
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`completion failed: ${msg}`);
            yield { type: 'error', message: msg, retryable: isRetryable(msg) };
            return;
          }

          history.push({ role: 'assistant', content: assistantText });
          saveHistory(continuation, history);
          yield { type: 'result', text: assistantText || null };

          next = null;
          while (!ended && !aborted && pending.length === 0) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length > 0) next = pending.shift()!;
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }

  private async *streamCompletion(
    history: ChatTurn[],
    instructions?: string,
  ): AsyncGenerator<{ kind: 'delta'; text: string } | { kind: 'usage'; text: string }> {
    const messages: { role: string; content: string }[] = [];
    if (instructions) messages.push({ role: 'system', content: instructions });
    messages.push(...history);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      ...proxyOption(),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
    }

    for await (const data of sseLines(res.body)) {
      if (data === '[DONE]') return;
      let json: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield { kind: 'delta', text: delta };
      if (json.usage) {
        const u = json.usage;
        yield {
          kind: 'usage',
          text: `tokens in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'} total=${u.total_tokens ?? '?'}`,
        };
      }
    }
  }
}

registerProvider('openai', (opts) => new OpenAIProvider(opts));
