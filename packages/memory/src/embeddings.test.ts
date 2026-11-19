import { describe, it, expect } from 'vitest';
import { resolveEmbeddingConfig, embeddingsEnabled } from './embeddings.js';

describe('resolveEmbeddingConfig', () => {
  it('returns null when GHITA_MEMORY_EMBEDDINGS is off (default)', () => {
    expect(resolveEmbeddingConfig({})).toBe(null);
    expect(embeddingsEnabled({})).toBe(false);
  });

  it('returns null when provider on but API key missing', () => {
    expect(resolveEmbeddingConfig({ GHITA_MEMORY_EMBEDDINGS: 'openai' })).toBe(null);
  });

  it('returns openai config when both set', () => {
    const c = resolveEmbeddingConfig({ GHITA_MEMORY_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-test' });
    expect(c).not.toBe(null);
    expect(c?.provider).toBe('openai');
    expect(c?.model).toBe('text-embedding-3-small');
  });
});
