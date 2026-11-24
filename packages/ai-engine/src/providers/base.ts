import type { AIProviderType, AIStreamChunk } from '@ghita/shared';
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ProviderConfig,
  EmbeddingResponse,
  EmbeddingManyResponse,
} from '../types.js';
import { AIUnsupportedFeatureError } from '../errors/index.js';
import { KeyManager } from '../key-manager.js';
import {
  toStandardRequest,
  type StandardRequest,
  type StandardWireFormat,
} from '../standard-request.js';
import type { ProviderCapabilities } from './types.js';

export abstract class BaseProvider implements AIProvider {
  abstract readonly type: AIProviderType;
  abstract readonly name: string;
  abstract readonly defaultModel: string;
  abstract readonly models: string[];

  protected config: ProviderConfig;
  protected keyManager: KeyManager;

  constructor(config: ProviderConfig) {
    this.config = config;

    const keys =
      config.apiKeys && config.apiKeys.length > 0
        ? config.apiKeys
        : config.apiKey
          ? [config.apiKey]
          : [];
    this.keyManager = new KeyManager(keys, config.rotationStrategy ?? 'failover');
  }

  abstract isReady(): Promise<boolean>;
  abstract chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  abstract chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<AIStreamChunk>;

  async test(): Promise<boolean> {
    try {
      const response = await this.chat([{ role: 'user', content: 'Hello' }], {
        maxTokens: 10,
      });
      return response.content.length > 0;
    } catch {
      return false;
    }
  }

  protected getModel(options?: ChatOptions): string {
    return options?.model || this.config.defaultModel || this.defaultModel;
  }

  protected getMaxTokens(options?: ChatOptions): number {
    return options?.maxTokens || this.config.maxTokens || 4096;
  }

  protected getTemperature(options?: ChatOptions): number {
    return options?.temperature ?? this.config.temperature ?? 0.7;
  }

  protected getApiKey(): string {
    const key = this.keyManager.getNextKey();
    if (!key) {
      const needsNoKey = this.type === 'ollama' || this.type === 'opencode-zen';
      if (needsNoKey) {
        return '';
      }
      throw new Error(`${this.name}: No healthy API key available`);
    }
    return key;
  }

  protected reportKeySuccess(key: string): void {
    this.keyManager.reportSuccess(key);
  }

  protected reportKeyFailure(key: string, statusCode?: number): void {
    this.keyManager.reportFailure(key, statusCode);
  }

  /**
   * Track S2 switch-key ladder: pick a DIFFERENT healthy key for the next
   * attempt. The failed key is already cooling down (reportKeyFailure ran in
   * the provider error path), so KeyManager rotation naturally yields another
   * key; `exclude` additionally rules out keys this request already tried.
   * Returns null when no eligible alternative exists.
   */
  switchKey(exclude: ReadonlySet<string> = new Set()): string | null {
    return this.keyManager.getNextKey(exclude);
  }

  /** Get key manager for health status reporting */
  getKeyManager(): KeyManager {
    return this.keyManager;
  }

  protected getBaseUrl(): string | undefined {
    return this.config.baseUrl;
  }

  /** Wire-format family this provider speaks. Override in non-OpenAI wires. */
  protected wireFormat(): StandardWireFormat {
    return 'openai';
  }

  /** Build the canonical StandardRequest for this provider's next wire call. */
  protected buildStandardRequest(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    model: string,
  ): StandardRequest {
    return toStandardRequest(messages, options, {
      wire: this.wireFormat(),
      model,
      maxTokens: this.getMaxTokens(options),
      temperature: this.getTemperature(options),
    });
  }

  async embed(_text: string, _options?: { model?: string }): Promise<EmbeddingResponse> {
    throw new AIUnsupportedFeatureError(this.name, 'embed');
  }

  async embedMany(_texts: string[], _options?: { model?: string }): Promise<EmbeddingManyResponse> {
    throw new AIUnsupportedFeatureError(this.name, 'embedMany');
  }

  async generateImage(
    _prompt: string,
    _options?: Record<string, unknown>,
  ): Promise<{ url: string; b64?: string }> {
    throw new AIUnsupportedFeatureError(this.name, 'generateImage');
  }

  async generateSpeech(
    _text: string,
    _options?: Record<string, unknown>,
  ): Promise<{ audio: Buffer; contentType: string }> {
    throw new AIUnsupportedFeatureError(this.name, 'generateSpeech');
  }

  async generateVideo(
    _prompt: string,
    _options?: Record<string, unknown>,
  ): Promise<{ url: string }> {
    throw new AIUnsupportedFeatureError(this.name, 'generateVideo');
  }

  async transcribe(_audio: Buffer, _options?: Record<string, unknown>): Promise<{ text: string }> {
    throw new AIUnsupportedFeatureError(this.name, 'transcribe');
  }

  /**
   * Returns the capabilities of this provider.
   * Subclasses should override this with accurate capability info.
   */
  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: false,
      imageGeneration: false,
      speechSynthesis: false,
      speechRecognition: false,
      videoGeneration: false,
      functionCalling: false,
      visionInput: false,
      reasoningTokens: false,
    };
  }
}
