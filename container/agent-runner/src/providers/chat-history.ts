import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Minimal on-disk chat history for providers that wrap a stateless chat API
 * (OpenAI, Gemini) instead of a harness with its own transcript. The
 * continuation token is the history file's id; the poll-loop persists it and
 * hands it back on the next wake, so multi-turn context survives the
 * ephemeral container.
 *
 * System instructions are NOT stored here — they are re-applied per call from
 * the freshly composed system prompt, so a prompt change takes effect on the
 * next turn instead of being frozen at session start.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

function stateDir(): string {
  const base = process.env.NANOCLAW_CHAT_STATE_DIR || path.join(os.homedir(), '.nanoclaw-chat');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function historyPath(continuation: string): string {
  // Continuation ids are provider-prefixed uuids; safe as filenames, but
  // sanitize defensively so a malformed token can't escape the state dir.
  const safe = continuation.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(stateDir(), `${safe}.json`);
}

export function loadHistory(continuation: string | undefined): ChatTurn[] {
  if (!continuation) return [];
  try {
    const raw = fs.readFileSync(historyPath(continuation), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatTurn[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(continuation: string, turns: ChatTurn[]): void {
  try {
    fs.writeFileSync(historyPath(continuation), JSON.stringify(turns));
  } catch {
    /* best-effort: a lost history file just means the next turn lacks context */
  }
}

/** True when the error text indicates the history file is gone or unreadable. */
export function historyMissing(continuation: string): boolean {
  try {
    return !fs.existsSync(historyPath(continuation));
  } catch {
    return true;
  }
}
