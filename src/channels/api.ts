/**
 * API channel — talk to your agent from a custom client (iOS app, etc.) over
 * plain HTTP, instead of routing through Telegram/Slack/WhatsApp.
 *
 * This is the sanctioned way to give a native client a first-class channel:
 * it implements the same `ChannelAdapter` contract as every other channel, so
 * sessions, `/clear`, approvals and delivery all work identically.
 *
 * Activates only when `API_CHANNEL_TOKEN` is set in `.env` (mirrors the
 * credential-gated factories of slack/whatsapp). All requests must carry that
 * token as `Authorization: Bearer <token>`.
 *
 * Wire protocol (one logical user, `platform_id = "app"`):
 *
 *   POST /api/message        { "text": "user message" }   → 202 { ok: true }
 *       Injects an inbound message and returns immediately. The agent's
 *       reply(ies) arrive asynchronously on the event stream below — this
 *       mirrors how a chat app works (you send, replies stream back), and it
 *       naturally supports multi-part replies.
 *
 *   GET  /api/events         → text/event-stream (SSE)
 *       Long-lived stream of the agent's outbound messages. Each delivered
 *       message is one `data: {"text": "..."}` event. Send a heartbeat comment
 *       every 25s so proxies don't drop the connection. Browsers' EventSource
 *       can't set headers, so the token may also be passed as `?token=<token>`.
 *
 *   GET  /api/health         → { status: "ok" }   (no auth)
 *
 * Audio is intentionally NOT handled here: the client does speech↔text against
 * the existing local Whisper (:7999) and F5-TTS (:7998) services, and exchanges
 * plain text with this adapter. Keeps the messaging bridge and the voice layer
 * decoupled.
 *
 * SECURITY: the bearer token is the only gate. Bind behind a TLS-terminating
 * reverse proxy / firewall in production — do not expose the raw port to the
 * internet without TLS.
 */
import crypto from 'crypto';
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'app';
const DEFAULT_PORT = 8787;
const HEARTBEAT_MS = 25_000;

/** Constant-time bearer-token check. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function createAdapter(token: string, port: number): ChannelAdapter {
  let server: http.Server | null = null;
  // Connected SSE clients. One user, but allow several (phone + laptop) — every
  // outbound message fans out to all of them.
  const clients = new Set<http.ServerResponse>();
  let heartbeat: NodeJS.Timeout | null = null;

  function authOK(req: http.IncomingMessage, queryToken?: string): boolean {
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;
    return tokenMatches(bearer ?? queryToken, token);
  }

  const adapter: ChannelAdapter = {
    name: 'api',
    channelType: 'api',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      server = http.createServer((req, res) => handleRequest(req, res, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, '0.0.0.0', () => {
          log.info('API channel listening', { port });
          resolve();
        });
      });
      heartbeat = setInterval(() => {
        for (const res of clients) {
          try {
            res.write(': ping\n\n');
          } catch {
            // dropped client is cleaned up by its own 'close' handler
          }
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    },

    async teardown(): Promise<void> {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // best-effort
        }
      }
      clients.clear();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const text = extractText(message);
      if (text === null) return undefined;
      const payload = `data: ${JSON.stringify({ text })}\n\n`;
      for (const res of clients) {
        try {
          res.write(payload);
        } catch (err) {
          log.warn('API channel: failed to write to SSE client', { err });
        }
      }
      // No live client → the outbound row is already persisted in outbound.db,
      // so it isn't lost; the client just won't see it until reconnect.
      return undefined;
    },
  };

  function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: ChannelSetup,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && path === '/api/events') {
      if (!authOK(req, url.searchParams.get('token') ?? undefined)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      log.info('API channel: SSE client connected', { clients: clients.size });
      req.on('close', () => {
        clients.delete(res);
        log.info('API channel: SSE client disconnected', { clients: clients.size });
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/message') {
      if (!authOK(req)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 1_000_000) {
          return sendJson(res, 413, { error: 'payload too large' });
        }
        chunks.push(chunk as Buffer);
      }
      let text: unknown;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        text = body.text;
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      if (typeof text !== 'string' || text.length === 0) {
        return sendJson(res, 400, { error: 'field "text" (non-empty string) is required' });
      }
      const id = `api-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await config.onInbound(PLATFORM_ID, null, {
          id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: {
            text,
            sender: 'app',
            senderId: `app:${PLATFORM_ID}`,
          },
        });
      } catch (err) {
        log.error('API channel: onInbound threw', { err });
        return sendJson(res, 500, { error: 'internal error' });
      }
      return sendJson(res, 202, { ok: true, id });
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return adapter;
}

registerChannelAdapter('api', {
  factory: () => {
    const env = readEnvFile(['API_CHANNEL_TOKEN', 'API_CHANNEL_PORT']);
    const token = env.API_CHANNEL_TOKEN;
    if (!token) return null;
    const port = env.API_CHANNEL_PORT ? Number(env.API_CHANNEL_PORT) : DEFAULT_PORT;
    return createAdapter(token, Number.isFinite(port) ? port : DEFAULT_PORT);
  },
});
