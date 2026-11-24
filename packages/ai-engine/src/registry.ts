import type { AIProviderType } from '@ghita/shared';
import { AI_PROVIDERS } from '@ghita/shared';
import type { AIProvider, ProviderConfig } from './types.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { OllamaProvider } from './providers/ollama.js';
import { CustomProvider } from './providers/custom.js';
import { GroqProvider } from './providers/groq.js';
import { MistralProvider } from './providers/mistral.js';
// v0.4.9 A5: dedicated OpenAI-compatible + Azure providers
import { XAIProvider } from './providers/xai.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { TogetherProvider } from './providers/together.js';
import { PerplexityProvider } from './providers/perplexity.js';
import { AzureOpenAIProvider } from './providers/azure-openai.js';
// Track S2: wire the defineVendor dedicated classes that previously fell
// through to the default throw (kimi/minimax) or the CustomProvider shim
// (deepseek).
import { KimiProvider } from './providers/kimi.js';
import { MiniMaxProvider } from './providers/minimax.js';
import { DeepSeekProvider } from './providers/deepseek.js';

export class ProviderRegistry {
  private providers = new Map<AIProviderType, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.type, provider);
  }

  registerFromConfig(config: ProviderConfig): AIProvider {
    const provider = this.createProvider(config);
    this.register(provider);
    return provider;
  }

  get(type: AIProviderType): AIProvider | undefined {
    return this.providers.get(type);
  }

  getAll(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getTypes(): AIProviderType[] {
    return Array.from(this.providers.keys());
  }

  has(type: AIProviderType): boolean {
    return this.providers.has(type);
  }

  remove(type: AIProviderType): boolean {
    return this.providers.delete(type);
  }

  clear(): void {
    this.providers.clear();
  }

  async getStatus(): Promise<Array<{ type: AIProviderType; name: string; ready: boolean }>> {
    const results: Array<{ type: AIProviderType; name: string; ready: boolean }> = [];
    for (const provider of this.providers.values()) {
      results.push({
        type: provider.type,
        name: provider.name,
        ready: await provider.isReady(),
      });
    }
    return results;
  }

  private createProvider(config: ProviderConfig): AIProvider {
    switch (config.type) {
      case 'openai':
        return new OpenAIProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'google':
        return new GoogleProvider(config);
      case 'ollama':
        return new OllamaProvider(config);
      case 'custom':
        return new CustomProvider(config);

      case 'groq':
        return new GroqProvider(config);

      case 'mistral':
        return new MistralProvider(config);
      // v0.4.9 A5: Dedicated providers (proper models + capabilities)
      case 'xai':
        return new XAIProvider(config);
      case 'openrouter':
        return new OpenRouterProvider(config);
      case 'together':
        return new TogetherProvider(config);
      case 'perplexity':
        return new PerplexityProvider(config);
      case 'azure-openai':
        return new AzureOpenAIProvider(config);
      // Track S2: dedicated defineVendor providers now wired into the registry.
      case 'kimi':
        return new KimiProvider(config);
      case 'minimax':
        return new MiniMaxProvider(config);
      case 'deepseek':
        return new DeepSeekProvider(config);
      // OpenAI-compatible providers (reuse CustomProvider)

      case 'opengateway':
      case 'mimo':
      case 'hicap':
      case 'github-models':
      case 'cerebras':
      case 'fireworks':
      case 'cohere':
      case 'replicate':
      case 'voyage':
      case 'ai21':
      case 'sambanova':
      case 'novita':
      case 'opencode-zen':
      case 'nvidia-nim':
        return new CustomProvider({
          ...config,
          providerType: config.type,
          providerName: AI_PROVIDERS[config.type]?.name ?? config.type,
        });
      default:
        throw new Error(`Unknown provider type: ${config.type as string}`);
    }
  }
}
