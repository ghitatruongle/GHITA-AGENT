# @ghita/relay-server

![Version](https://img.shields.io/badge/version-0.1.0-blue)

Relay server for Ghita Agent -- WebSocket-based message relay that bridges desktop and mobile clients with authentication, connection pooling, and message queuing.

## Key Features

- **WebSocket relay** -- bidirectional message relay between desktop daemon and mobile clients.
- **Connection pooling** -- maintains persistent connections with automatic reconnection handling.
- **Message queuing** -- queues messages for offline clients and delivers on reconnect.
- **Authentication** -- token-based auth with session management and expiry handling.
- **Multi-tenant support** -- isolates relay channels per workspace/user for security.

## Installation

```bash
pnpm install --filter @ghita/relay-server
```

## Usage

```typescript
import { RelayServer } from '@ghita/relay-server';

const server = new RelayServer({ port: 3002 });
await server.start();
server.on('relay:connect', (clientId) => console.log(`${clientId} connected`));
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
