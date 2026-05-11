/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  model?: string;
  effort?: string;
}

const DEFAULT_MAX_MESSAGES = 10;

// Matches `$VAR` or `${VAR}` as the entire string — substring interpolation is
// intentionally NOT supported to avoid surprises with literal `$` in tokens.
const ENV_REF = /^\$\{?(\w+)\}?$/;

function expandEnvRefs(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = typeof v === 'string' ? ENV_REF.exec(v) : null;
    if (m && process.env[m[1]] !== undefined) out[k] = process.env[m[1]] as string;
    else out[k] = v;
  }
  return out;
}

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: Object.fromEntries(
      Object.entries((raw.mcpServers as RunnerConfig['mcpServers']) || {}).map(([name, server]) => [
        name,
        { ...server, env: expandEnvRefs(server.env) },
      ]),
    ),
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
