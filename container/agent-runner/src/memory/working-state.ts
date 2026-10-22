import fs from 'fs';
import path from 'path';

export const WORKING_STATE_FILE = 'working-state.md';
export const WORKING_STATE_BUDGET_CHARS = 8_000;
export const WORKING_STATE_TRUNCATION_NOTICE = '[truncated: remove finished items and keep this file short]';
const WORKING_STATE_EMPTY_NOTICE = '(empty: create the file when you have work in flight)';

/**
 * Render the agent's working state: what is in flight right now. The
 * compaction summary paraphrases and drops detail, so the agent keeps the
 * open tasks, approvals and next steps in a file it owns, and this section
 * puts that file back in front of it whenever a context window starts.
 */
export function renderWorkingStateSection(baseDir = '/workspace/agent'): string {
  return [
    '## Working state',
    '',
    `\`/workspace/agent/${WORKING_STATE_FILE}\` is your working state: what is in flight right now.`,
    'It is loaded at startup, after clear, and after compaction, so it survives when the',
    'conversation summary loses detail. Update it while you work, not at the end:',
    '',
    '- open tasks: who asked (destination and message id), what is done, the exact next step',
    '- approvals you asked for and the answer, quoted with its message id; an approval covers',
    '  only the task it was given for',
    '- decisions and their reasons, and what is waiting on whom',
    '- exact paths, branches, commits and ids you will need again',
    '',
    'Remove an item once it is finished and reported. Keep the file under',
    `${WORKING_STATE_BUDGET_CHARS.toLocaleString('en-US')} characters; durable knowledge belongs in memory, not here.`,
    'Never write credentials or secret values in it. Before acting on an item, check it',
    'against the latest messages: the user may have changed or cancelled it.',
    '',
    `### ${WORKING_STATE_FILE}`,
    '',
    readWorkingState(path.join(baseDir, WORKING_STATE_FILE)),
    '',
  ].join('\n');
}

function readWorkingState(filePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return WORKING_STATE_EMPTY_NOTICE;
    return '(unavailable during this hook invocation)';
  }
  if (!content) return WORKING_STATE_EMPTY_NOTICE;
  if (content.length <= WORKING_STATE_BUDGET_CHARS) return content;

  let truncated = content.slice(0, WORKING_STATE_BUDGET_CHARS);
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
  return `${truncated}\n${WORKING_STATE_TRUNCATION_NOTICE}`;
}
