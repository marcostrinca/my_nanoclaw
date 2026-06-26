import { randomUUID } from 'crypto';

import { registerProvider } from './provider-registry.js';
import { loadHistory, saveHistory, historyMissing, type ChatTurn } from './chat-history.js';
import { proxyOption, isRetryable, sseLines } from './provider-http.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[gemini-provider] ${msg}`);
}

const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google Gemini provider. Text-in/text-out: it streams the model's reply and
 * lets the poll-loop dispatch any `<message to="…">` blocks the model emits.
 * No native tool loop — the agent talks, the loop delivers.
 *
 * Auth goes through the OneCLI gateway like the other providers: we send a
 * placeholder `x-goog-api-key` and the proxy rewrites it on the wire. Set
 * GEMINI_API_KEY only if running without the gateway.
 */
export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly usesMemoryScaffold = true;

  private model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model || options.env?.GEMINI_MODEL || DEFAULT_MODEL;
    this.baseUrl = (options.env?.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.env?.GEMINI_API_KEY || options.env?.GOOGLE_API_KEY || 'placeholder';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /history missing/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation && historyMissing(input.continuation)) {
      const events: AsyncIterable<ProviderEvent> = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'activity' };
          throw new Error(`history missing for ${input.continuation}`);
        },
      };
      return { push() {}, end() {}, events, abort() {} };
    }

    const continuation = input.continuation || `gemini-${randomUUID()}`;
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
            for await (const ev of self.streamGenerate(history, instructions)) {
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
            log(`generate failed: ${msg}`);
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

  private async *streamGenerate(
    history: ChatTurn[],
    instructions?: string,
  ): AsyncGenerator<{ kind: 'delta'; text: string } | { kind: 'usage'; text: string }> {
    const contents = history.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    }));

    const body: Record<string, unknown> = { contents };
    if (instructions) body.system_instruction = { parts: [{ text: instructions }] };

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      ...proxyOption(),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
    }

    for await (const data of sseLines(res.body)) {
      if (!data) continue;
      let json: {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (p.text) yield { kind: 'delta', text: p.text };
      }
      if (json.usageMetadata) {
        const u = json.usageMetadata;
        yield {
          kind: 'usage',
          text: `tokens in=${u.promptTokenCount ?? '?'} out=${u.candidatesTokenCount ?? '?'} total=${u.totalTokenCount ?? '?'}`,
        };
      }
    }
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
