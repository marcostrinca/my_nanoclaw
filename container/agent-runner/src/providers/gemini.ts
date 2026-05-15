import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * Gemini provider — uses Google's Generative Language API for inference.
 *
 * Status: skeleton. Tool use loop not yet implemented.
 *
 * Required env:
 *   GOOGLE_API_KEY or GOOGLE_APPLICATION_CREDENTIALS
 *
 * Model selection via ProviderOptions.model (default: gemini-2.5-pro).
 */

const DEFAULT_MODEL = 'gemini-2.5-pro';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private model: string;
  private assistantName: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model || DEFAULT_MODEL;
    this.assistantName = options.assistantName || 'Assistant';
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const model = this.model;
    const assistantName = this.assistantName;

    const systemInstruction = [
      input.systemContext?.instructions ?? '',
      `Your name is ${assistantName}.`,
    ].filter(Boolean).join('\n\n');

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };

        const sessionId = `gemini-${Date.now()}`;
        yield { type: 'init', continuation: input.continuation ?? sessionId };

        // --- Phase 1: simple text generation (no tool use) ---
        try {
          yield { type: 'progress', message: 'Calling Gemini API...' };

          const body = {
            system_instruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 8192,
            },
            // TODO Phase 2: add tool declarations here
            // tools: [{ function_declarations: [...] }],
          };

          const url = `${API_BASE}/models/${model}:generateContent`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          yield { type: 'activity' };

          if (!res.ok) {
            const errText = await res.text();
            yield { type: 'error', message: `Gemini API ${res.status}: ${errText}`, retryable: res.status >= 500 };
            return;
          }

          const data = await res.json() as any;
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

          yield { type: 'activity' };
          yield { type: 'result', text };

          // Process pushed follow-ups (same simple pattern)
          while (!ended && !aborted) {
            if (pending.length > 0) {
              const msg = pending.shift()!;
              yield { type: 'activity' };

              const followUpBody = {
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents: [
                  { role: 'user', parts: [{ text: input.prompt }] },
                  { role: 'model', parts: [{ text: text ?? '' }] },
                  { role: 'user', parts: [{ text: msg }] },
                ],
                generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
              };

              const followRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(followUpBody),
              });

              yield { type: 'activity' };

              if (followRes.ok) {
                const followData = await followRes.json() as any;
                const followText = followData?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
                yield { type: 'result', text: followText };
              } else {
                const errText = await followRes.text();
                yield { type: 'error', message: `Gemini follow-up ${followRes.status}: ${errText}`, retryable: false };
              }
            } else {
              // Wait for push() or end()
              await new Promise<void>((resolve) => { waiting = resolve; });
              waiting = null;
            }
          }

        } catch (err: any) {
          yield { type: 'error', message: `Gemini provider error: ${err.message}`, retryable: false };
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
}

// --- Self-register ---
registerProvider('gemini', (options) => new GeminiProvider(options));
