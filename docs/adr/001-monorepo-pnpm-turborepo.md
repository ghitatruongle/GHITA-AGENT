# ADR-001: Monorepo with pnpm + Turborepo

**Status:** Accepted
**Date:** 2026-05-19
**Deciders:** GHITA Team

## Context

Ghita Agent consists of multiple packages (ai-engine, agents, skills, communication, etc.) and apps (desktop, mobile, vscode-extension). These share common types and utilities. Managing separate repositories would create coordination overhead and version drift.

## Decision

Use pnpm workspaces with Turborepo for monorepo orchestration:

- pnpm for dependency management (fast, disk-efficient, strict)
- Turborepo for build orchestration (caching, parallel execution, task dependencies)
- 22 internal packages under `packages/`
- 3 apps under `apps/`

## Consequences

**Positive:**

- Single install command for all packages
- Shared types via `@ghita/shared` without publishing
- Turborepo caching reduces build times
- Atomic commits across packages

**Negative:**

- Larger repository size
- Requires understanding of monorepo tooling
- CI needs to handle all packages
