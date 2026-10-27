# Troubleshooting Guide

## Desktop App Won't Start

**Symptoms:** Application crashes on launch, blank window, or "sidecar not found"

**Solutions:**

1. **Check Rust installation:** `rustc --version` (should be >= 1.70)
2. **Rebuild sidecar server:**
   ```bash
   cd apps/desktop/src-tauri/sidecar
   node server.mjs --build
   cd ../../..
   ```
3. **Check port availability:**
   ```bash
   netstat -an | findstr 8080
   ```
   Ensure port 8080 is not occupied by another application.
4. **Clear Tauri cache:**
   ```bash
   rm -rf ~/.cache/ghita-coding-agent
   ```
5. **Full rebuild:**
   ```bash
   pnpm rebuild
   ```

## Mobile Can't Connect to Desktop

**Symptoms:** "Connection failed", spinning indicator, timeout, or "No devices found"

**Solutions:**

1. **Network check:** Ensure both devices are on the same WiFi network
2. **Firewall:** Ensure port 8080 is not blocked by Windows Defender Firewall or similar
3. **Manual IP:** Go to Settings → enter desktop IP address manually instead of auto-discovery
4. **Restart server:** Click "Restart Communication Server" in Dashboard view
5. **Pairing code:** Verify the 6-digit pairing code is correct and hasn't expired
6. **Bluetooth:** If using Bluetooth pairing, ensure Bluetooth is enabled on both devices

## AI Provider Errors

| Error Code       | Cause                           | Solution                                                       |
| ---------------- | ------------------------------- | -------------------------------------------------------------- |
| 401 Unauthorized | Invalid or missing API key      | Check `.env` file for correct API key                          |
| 429 Rate Limited | Too many requests in short time | Wait 60s, use multiple API keys, or switch to another provider |
| 503 Service Down | Provider outage                 | Switch to another provider via Smart Router                    |
| Timeout          | Network latency or slow model   | Reduce `max_tokens` or switch to faster model                  |
| 400 Bad Request  | Invalid parameters              | Check model name and message format                            |

## Common Error Messages

### "Skill not found: X"

The skill `X` is not registered. Check that:

- The skill ID is correct
- The skill package is installed
- The skill is not disabled

### "Skill is disabled: X"

The skill exists but is disabled. Enable it in the Skills view.

### "No healthy provider available"

All configured AI providers have exhausted their API keys or are currently unavailable. Check:

- API key validity
- Provider health status in API Manager
- Network connectivity

### "Pairing code expired"

The 6-digit pairing code has timed out (default 5 minutes). Generate a new code from the Desktop dashboard.

## Build Errors

### TypeScript compilation errors

Run `pnpm typecheck` to see all errors. Common fixes:

- Ensure all dependencies are installed: `pnpm install`
- Check TypeScript version compatibility
- Verify module resolution paths in `tsconfig.json`

### Rust compilation errors (Tauri)

- Ensure Rust is up to date: `rustup update`
- Check Tauri CLI version: `cargo install tauri-cli --version "^2"`
- On Windows, install Visual Studio Build Tools with C++ support

### Android build failures

- Ensure Android Studio is installed with SDK 28+
- Check Java version: `java -version` (needs Java 17)
- Run `cd apps/mobile/android && ./gradlew clean`

## Performance Issues

### Desktop app is slow

- Close unused tabs in the editor
- Reduce the number of active AI providers
- Use local AI (Ollama) for simple queries
- Check memory usage: Tauri app may use 500MB-1GB RAM

### AI response is slow

- Switch to a faster model (GPT-4o-mini instead of GPT-4o)
- Check network latency to AI provider
- Enable response caching in Settings
- Reduce max_tokens for shorter responses

## Still Having Issues?

If none of the above solutions work:

1. Check [GitHub Issues](https://github.com/ghitatruongle/GHITA-AGENT/issues) for similar problems
2. Create a new issue with:
   - Your OS and version
   - Steps to reproduce
   - Full error logs
   - Screenshots if applicable
