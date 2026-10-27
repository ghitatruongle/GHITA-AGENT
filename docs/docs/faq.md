# Frequently Asked Questions

## General

### What is Ghita Agent?

An AI-powered desktop application with remote Android control, similar to Claude Code but self-hosted. It provides a VS Code-style code editor, multi-provider AI support, a skill system, agent teams, and remote computer control via Android phone.

### Is it free?

Yes, it's MIT licensed. You only pay for AI API usage from providers like OpenAI, Anthropic, etc.

### Do I need a GPU?

No. For local AI, Ollama runs on CPU (GPU optional for better performance).

## Technical

### Which AI providers are supported?

OpenAI, Anthropic, Google (Gemini), Ollama, Groq, Mistral, DeepSeek, Kimi, MiniMax, and custom OpenAI-compatible providers. You can configure multiple keys per provider for load balancing and failover.

### Can I use it without internet?

Yes, partially. With Ollama for local LLMs, the core AI features work offline. Communication features between desktop and mobile require a local network (WiFi).

### Is my data private?

Yes. Since it's self-hosted, your data stays on your machine. Telemetry is opt-in. API calls to external providers are subject to their privacy policies.

### How does the Smart Router work?

It analyzes task complexity and routes to the most appropriate model — simple queries go to fast/cheap models, complex tasks go to powerful models. This optimizes both cost and quality.

## Development

### How do I create a custom skill?

See the [Custom Skill Tutorial](./tutorials/custom-skill.md). You create a SKILL.md manifest and implement the skill interface.

### How do I add a new AI provider?

Implement the `LLMProvider` interface from `@ghita/ai-engine`, then register it via the ProviderRegistry or API Manager UI.

### Can I contribute?

Yes! See [Contributing](./contributing.md) for guidelines.

### How do I build from source?

```bash
git clone https://github.com/ghitatruongle/GHITA-AGENT.git
cd GHITA-AGENT
pnpm install
cp .env.example .env  # Edit with your API keys
pnpm build:packages
```

## Troubleshooting

### Desktop app won't start

See the [Troubleshooting Guide](./troubleshooting.md) for detailed solutions.

### Mobile can't connect to desktop

- Ensure both devices are on the same network
- Check firewall isn't blocking port 8080
- Try manual IP address instead of auto-discovery
- Verify the 6-digit pairing code

### AI provider not working

- Verify API keys in `.env` file
- Check provider is enabled in API Manager
- For Ollama, run `ollama serve`
- Check network connectivity

## Miscellaneous

### What's the tech stack?

Desktop: Tauri 2.x + React (TypeScript). Mobile: React Native (Android). AI: Vercel AI SDK. Build: Turborepo + pnpm.

### What Android version is required?

Android 9 (Pie) or higher (API 28+).

### Does it support iOS?

Not yet. Mobile support is currently Android-only.

### How is security handled?

Multiple layers: shell injection prevention, SQL injection prevention (SELECT-only), PII detection, content filtering, permission system, audit logging, and rate limiting.
