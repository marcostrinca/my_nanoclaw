import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('returns OpenAIProvider for openai', () => {
    expect(createProvider('openai')).toBeInstanceOf(OpenAIProvider);
  });

  it('returns GeminiProvider for gemini', () => {
    expect(createProvider('gemini')).toBeInstanceOf(GeminiProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});
