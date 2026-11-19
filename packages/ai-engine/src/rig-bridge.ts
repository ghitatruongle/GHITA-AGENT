// v0.0.2-preview T5 — opt-in Rust engine bridge. isRustEngineEnabled() đọc
// GHITA_ENGINE=native; tryNativeCompletion() gọi addon qua native-bridge,
// trả null khi flag tắt/addon vắng/throw → caller rơi về TS provider hiện có.

import { loadNative } from '@ghita/native-bridge';

export interface NativeCompletionPayload {
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number | null;
}

export function isRustEngineEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.GHITA_ENGINE ?? '').toLowerCase() === 'native';
}

interface EngineNativeModule {
  engineComplete(payload: string): Promise<string>;
  engineAvailable(): boolean;
}

const FALLBACK: EngineNativeModule = {
  engineComplete: () => Promise.reject(new Error('engine addon unavailable')),
  engineAvailable: () => false,
};

export interface NativeCompletionResult {
  text: string;
  provider: string;
  model: string;
  usageIn: number;
  usageOut: number;
}

const NATIVE_TIMEOUT_MS = 120_000;

/** F8 review: trả đủ usage để gateway ghi sổ cost/audit; F9: timeout 120s
 *  tránh Promise treo vĩnh viễn khi provider chết. */
export async function tryNativeCompletion(
  payload: NativeCompletionPayload,
): Promise<NativeCompletionResult | null> {
  if (!isRustEngineEnabled()) return null;
  const loaded = loadNative<EngineNativeModule>('engine', FALLBACK);
  if (!loaded.native) return null;
  try {
    const raw = await Promise.race([
      loaded.impl.engineComplete(JSON.stringify(payload)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('native engine timeout (120s)')), NATIVE_TIMEOUT_MS),
      ),
    ]);
    const parsed = JSON.parse(raw) as {
      text?: string;
      provider?: string;
      model?: string;
      usage_in?: number;
      usage_out?: number;
    };
    if (typeof parsed.text !== 'string') return null;
    return {
      text: parsed.text,
      provider: parsed.provider ?? payload.provider,
      model: parsed.model ?? payload.model,
      usageIn: typeof parsed.usage_in === 'number' ? parsed.usage_in : 0,
      usageOut: typeof parsed.usage_out === 'number' ? parsed.usage_out : 0,
    };
  } catch {
    return null;
  }
}
