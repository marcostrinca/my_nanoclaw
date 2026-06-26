import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenAIProvider } from './openai.js';
import type { ProviderEvent } from './types.js';

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(q: ReturnType<OpenAIProvider['query']>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of q.events) {
    events.push(ev);
    if (ev.type === 'result' || ev.type === 'error') q.end();
  }
  return events;
}

const origFetch = globalThis.fetch;
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-test-'));
  process.env.NANOCLAW_CHAT_STATE_DIR = stateDir;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.NANOCLAW_CHAT_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('OpenAIProvider', () => {
  it('streams a completion into a single result, with init + usage', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(init.body as string) };
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ model: 'gpt-4o-mini', env: {} });
    const q = provider.query({ prompt: 'hi', cwd: '/tmp', systemContext: { instructions: 'be nice' } });
    const events = await drain(q);

    const init = events.find((e) => e.type === 'init');
    expect(init && 'continuation' in init && init.continuation.startsWith('openai-')).toBe(true);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('Hello world');

    const usage = events.find((e) => e.type === 'progress') as Extract<ProviderEvent, { type: 'progress' }>;
    expect(usage.message).toContain('total=7');

    expect(captured!.url).toContain('/chat/completions');
    expect(captured!.body.model).toBe('gpt-4o-mini');
    const messages = captured!.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'be nice' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('persists history so a follow-up query resumes context', async () => {
    globalThis.fetch = (async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"first"}}]}\n\n', 'data: [DONE]\n\n'])) as unknown as typeof fetch;

    const provider = new OpenAIProvider();
    const q1 = provider.query({ prompt: 'one', cwd: '/tmp' });
    const events1 = await drain(q1);
    const init = events1.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    const continuation = init.continuation;

    let secondBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, reqInit: RequestInit) => {
      secondBody = JSON.parse(reqInit.body as string);
      return sseResponse(['data: {"choices":[{"delta":{"content":"second"}}]}\n\n', 'data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const q2 = provider.query({ prompt: 'two', cwd: '/tmp', continuation });
    await drain(q2);

    const messages = secondBody!.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.content)).toEqual(['one', 'first', 'two']);
  });

  it('throws for the poll-loop when the stored continuation has no history file', async () => {
    const provider = new OpenAIProvider();
    const q = provider.query({ prompt: 'x', cwd: '/tmp', continuation: 'openai-does-not-exist' });
    let thrown: Error | null = null;
    try {
      await drain(q);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/history missing/);
    expect(provider.isSessionInvalid(thrown)).toBe(true);
  });

  it('surfaces a non-ok HTTP status as an error event', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;
    const provider = new OpenAIProvider();
    const q = provider.query({ prompt: 'x', cwd: '/tmp' });
    const events = await drain(q);
    const err = events.find((e) => e.type === 'error') as Extract<ProviderEvent, { type: 'error' }>;
    expect(err.message).toContain('401');
  });
});
