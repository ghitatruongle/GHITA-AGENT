# Penetration Testing Checklist — Ghita Agent

> **Version:** 1.0
> **Last Updated:** 2026-06-24

## 1. Input Validation

- [ ] XSS via chat messages
- [ ] XSS via skill names/descriptions
- [ ] SQL injection via search queries
- [ ] Command injection via terminal commands
- [ ] Path traversal via file operations
- [ ] SSRF via URL inputs (AI engine, browser control)
- [ ] DNS rebinding attacks on SSRF protection

## 2. Authentication & Authorization

- [ ] Pairing code brute force (6-digit PIN)
- [ ] Session fixation on Socket.IO connections
- [ ] Token leakage in error messages
- [ ] Privilege escalation via skill permissions
- [ ] IDOR on device/session identifiers

## 3. Communication Security

- [ ] MitM on Socket.IO (should use WSS in production)
- [ ] Replay attacks on pairing protocol
- [ ] Message tampering on relay server
- [ ] Rate limiting on connection attempts

## 4. Computer Use Security

- [ ] Sandbox escape via computer-use commands
- [ ] Unauthorized keyboard/mouse input
- [ ] Screen capture data leakage
- [ ] Browser automation privilege escalation

## 5. API Key Security

- [ ] Memory dump exposure
- [ ] Log file exposure
- [ ] Environment variable leakage
- [ ] Key rotation failure modes

## 6. Dependency Security

- [ ] Known CVEs in dependencies
- [ ] License compliance (GPL/AGPL)
- [ ] Typosquatting attacks
- [ ] Supply chain attacks

## 7. Infrastructure

- [ ] CSP bypass attempts
- [ ] CORS misconfiguration
- [ ] Docker container escape
- [ ] Tauri IPC privilege escalation
