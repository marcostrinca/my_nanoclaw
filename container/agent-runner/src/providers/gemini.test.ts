import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GeminiProvider } from './gemini.js';
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

async function drain(q: ReturnType<GeminiProvider['query']>): Promise<ProviderEvent[]> {
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
  process.env.NANOCLAW_CHAT_STATE_DIR = stateDir;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.NANOCLAW_CHAT_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('GeminiProvider', () => {
  it('streams a generation into a single result, with init + usage', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(init.body as string) };
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Oi"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" mundo"}]}}]}\n\n',
        'data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
      ]);
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ model: 'gemini-2.5-flash', env: {} });
    const q = provider.query({ prompt: 'oi', cwd: '/tmp', systemContext: { instructions: 'seja gentil' } });
    const events = await drain(q);

    const init = events.find((e) => e.type === 'init');
    expect(init && 'continuation' in init && init.continuation.startsWith('gemini-')).toBe(true);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('Oi mundo');

    const usage = events.find((e) => e.type === 'progress') as Extract<ProviderEvent, { type: 'progress' }>;
    expect(usage.message).toContain('total=7');

    expect(captured!.url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
    expect(captured!.url).toContain('alt=sse');
    expect(captured!.body.system_instruction).toEqual({ parts: [{ text: 'seja gentil' }] });
    const contents = captured!.body.contents as { role: string; parts: { text: string }[] }[];
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'oi' }] });
  });

  it('persists history so a follow-up query resumes context with model role', async () => {
    globalThis.fetch = (async () =>
      sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"primeiro"}]}}]}\n\n'])) as unknown as typeof fetch;

    const provider = new GeminiProvider();
    const q1 = provider.query({ prompt: 'um', cwd: '/tmp' });
    const events1 = await drain(q1);
    const init = events1.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    const continuation = init.continuation;

    let secondBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, reqInit: RequestInit) => {
      secondBody = JSON.parse(reqInit.body as string);
      return sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"segundo"}]}}]}\n\n']);
    }) as unknown as typeof fetch;

    const q2 = provider.query({ prompt: 'dois', cwd: '/tmp', continuation });
    await drain(q2);

    const contents = secondBody!.contents as { role: string; parts: { text: string }[] }[];
    expect(contents.map((c) => ({ role: c.role, text: c.parts[0].text }))).toEqual([
      { role: 'user', text: 'um' },
      { role: 'model', text: 'primeiro' },
      { role: 'user', text: 'dois' },
    ]);
  });

  it('throws for the poll-loop when the stored continuation has no history file', async () => {
    const provider = new GeminiProvider();
    const q = provider.query({ prompt: 'x', cwd: '/tmp', continuation: 'gemini-does-not-exist' });
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
    globalThis.fetch = (async () => new Response('nope', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    const provider = new GeminiProvider();
    const q = provider.query({ prompt: 'x', cwd: '/tmp' });
    const events = await drain(q);
    const err = events.find((e) => e.type === 'error') as Extract<ProviderEvent, { type: 'error' }>;
    expect(err.message).toContain('403');
  });
});
