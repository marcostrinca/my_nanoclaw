import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  WORKING_STATE_BUDGET_CHARS,
  WORKING_STATE_FILE,
  WORKING_STATE_TRUNCATION_NOTICE,
  renderWorkingStateSection,
} from './working-state.js';

const BASE = '/tmp/nanoclaw-working-state-test';

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
});

afterEach(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('renderWorkingStateSection', () => {
  it('renders the file the agent keeps', () => {
    fs.writeFileSync(path.join(BASE, WORKING_STATE_FILE), '- deploy: waiting on the user\n');

    const section = renderWorkingStateSection(BASE);

    expect(section).toContain('## Working state');
    expect(section).toContain('- deploy: waiting on the user');
  });

  it('asks the agent to create the file when there is none yet', () => {
    expect(renderWorkingStateSection(BASE)).toContain('(empty: create the file when you have work in flight)');

    fs.writeFileSync(path.join(BASE, WORKING_STATE_FILE), '  \n');
    expect(renderWorkingStateSection(BASE)).toContain('(empty: create the file when you have work in flight)');
  });

  it('truncates a file over budget', () => {
    fs.writeFileSync(path.join(BASE, WORKING_STATE_FILE), 'x'.repeat(WORKING_STATE_BUDGET_CHARS + 50));

    const section = renderWorkingStateSection(BASE);

    expect(section).toContain(WORKING_STATE_TRUNCATION_NOTICE);
    expect(section).not.toContain('x'.repeat(WORKING_STATE_BUDGET_CHARS + 1));
  });
});
