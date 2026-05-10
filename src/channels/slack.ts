/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 *
 * Supports running multiple Slack bots in the same process simultaneously
 * (e.g. one bot per agent_group / workspace, each with its own credentials):
 *
 *   - Single-bot (legacy): SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET
 *       → channel_type "slack", webhook /webhook/slack
 *
 *   - Multi-bot: SLACK_BOT_TOKEN_<SLUG> + SLACK_SIGNING_SECRET_<SLUG>
 *       → channel_type "slack-<slug>", webhook /webhook/slack-<slug>
 *
 * Both modes can coexist. Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { listEnvKeysMatching, readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

function buildBridge(name: string, botToken: string, signingSecret: string) {
  const slackAdapter = createSlackAdapter({ botToken, signingSecret });
  // The Chat SDK bridge derives both channel_type and the webhook path from
  // adapter.name. Override here so multiple bots can co-exist on the shared
  // webhook server with distinct routes.
  (slackAdapter as { name: string }).name = name;
  const bridge = createChatSdkBridge({
    adapter: slackAdapter,
    concurrency: 'concurrent',
    supportsThreads: true,
  });
  // Mirror upstream behaviour: expose channel-name resolution so the
  // unknown-sender approval card can show readable names instead of IDs.
  bridge.resolveChannelName = async (platformId: string) => {
    try {
      const info = await slackAdapter.fetchThread(platformId);
      return (info as { channelName?: string }).channelName ?? null;
    } catch {
      return null;
    }
  };
  return bridge;
}

// Single-bot (legacy) — only registers if the un-suffixed token is set.
registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    return buildBridge('slack', env.SLACK_BOT_TOKEN, env.SLACK_SIGNING_SECRET || '');
  },
});

// Multi-bot — one registration per SLACK_BOT_TOKEN_<SLUG> entry in .env.
const TOKEN_PREFIX = 'SLACK_BOT_TOKEN_';
for (const fullKey of listEnvKeysMatching(TOKEN_PREFIX)) {
  const upper = fullKey.slice(TOKEN_PREFIX.length);
  if (!upper) continue;
  const slug = upper.toLowerCase();
  const channelType = `slack-${slug}`;
  registerChannelAdapter(channelType, {
    factory: () => {
      const env = readEnvFile([`SLACK_BOT_TOKEN_${upper}`, `SLACK_SIGNING_SECRET_${upper}`]);
      const token = env[`SLACK_BOT_TOKEN_${upper}`];
      const secret = env[`SLACK_SIGNING_SECRET_${upper}`] || '';
      if (!token) return null;
      return buildBridge(channelType, token, secret);
    },
  });
}
