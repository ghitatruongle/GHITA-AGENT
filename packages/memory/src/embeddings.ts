// v0.0.2-preview T4 P4.4b — embedding source cho durable vec0 index.
// GHITA_MEMORY_EMBEDDINGS=off (mặc định) → không gọi API ngoài (nhẹ máy,
// không tốn cost); khi bật (vd "openai") → embed text qua provider API.

export type EmbeddingProvider = 'openai' | 'off';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  apiKey?: string;
}

const DIM_1536 = 1536;

export function resolveEmbeddingConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingConfig | null {
  const raw = (env.GHITA_MEMORY_EMBEDDINGS ?? 'off').toLowerCase();
  if (raw !== 'openai') return null;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return { provider: 'openai', model: 'text-embedding-3-small', apiKey };
}

export async function embedText(text: string, config: EmbeddingConfig): Promise<number[]> {
  if (config.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey ?? ''}`,
      },
      body: JSON.stringify({ model: config.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`embedding provider error: ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== DIM_1536) {
      throw new Error('embedding provider returned unexpected vector length');
    }
    return vec;
  }
  throw new Error('embedding provider disabled');
}

/** True khi durable embedding pipeline được cấu hình bật. */
export function embeddingsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveEmbeddingConfig(env) !== null;
}
