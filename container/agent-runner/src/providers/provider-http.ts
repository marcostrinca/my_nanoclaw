/** Shared HTTP helpers for the chat-API providers (OpenAI, Gemini). */

/** Bun's fetch honors a per-request proxy; pass it only when one is configured. */
export function proxyOption(): { proxy?: string } {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return proxy ? { proxy } : {};
}

export function isRetryable(msg: string): boolean {
  return /\b(429|500|502|503|504)\b/.test(msg) || /timeout|ECONNRESET|fetch failed/i.test(msg);
}

/**
 * Decode a `text/event-stream` body into the payloads after each `data:`
 * prefix. Yields the raw payload string (caller JSON-parses or matches
 * `[DONE]`). Handles chunk boundaries that split mid-line.
 */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}
