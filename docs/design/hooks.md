# Hooks System — `.ghita/hooks.json` (v1.1.5-beta1 Track 1.2)

Declarative, self-healing hooks evaluated at every tool boundary of the agent
runtime (pattern: openclaude hook-chains + claude-code hooks + grok-build
hook events). Rules live in `.ghita/hooks.json` (project) or
`~/.ghita/hooks.json` (global, merged with lower precedence).

## Events

| Event                | Fires                                       | Can block?       |
| -------------------- | ------------------------------------------- | ---------------- |
| `SessionStart`       | before the first agent turn                 | no               |
| `PreToolUse`         | before a tool executes (after PolicyEngine) | **yes**          |
| `PostToolUse`        | after a tool succeeds                       | no (observe/log) |
| `PostToolUseFailure` | after a tool throws                         | no (observe/log) |
| `Stop`               | when the run finishes (any exit path)       | no               |
| `PreCompact`         | before context compaction (Track 2 wiring)  | no               |
| `SessionEnd`         | when the session ends                       | no (observe/log) |
| `SubagentStop`       | when a subagent finishes                    | no (observe/log) |
| `Notification`       | when the runtime raises a user notification | no (observe/log) |
| `UserPromptSubmit`   | when the user submits a prompt              | no (observe/log) |

The last four events mirror claude-code hooks (reference:
anthropics/claude-code docs/plugins, v0.0.1 T6.1) and carry typed payload
fields on the dispatch context: `SessionEnd` → `reason`
(`logout \| prompt_input \| clear \| other`), `SubagentStop` → `subagentId` +
optional `threadId`, `Notification` → `level` (`info \| warning \| error`) +
`message`, `UserPromptSubmit` → `prompt`.

## Schema

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "no-rm", // unique, required
      "events": ["PreToolUse"], // list or "*"
      "match": { "tool": "terminal.*" }, // omit = all tools; '*' suffix = prefix glob
      "action": {
        // exactly one of:
        "type": "block", //   hard block with reason
        "reason": "destructive commands disabled",
      },
      "cooldownMs": 10000, // optional: min interval between firings
      "dedupWindowMs": 5000, // optional: suppress identical (event,tool,input)
      "failOpen": true, // optional: errors never wedge the agent (default)
    },
  ],
}
```

### Shell action

```jsonc
{
  "type": "shell",
  "command": "node check-policy.js", // run via the current node executable
  "timeoutMs": 10000,
}
```

The child receives `HOOK_EVENT`, `HOOK_TOOL`, `HOOK_SESSION_ID`, `HOOK_INPUT`
(JSON) and `HOOK_CONTEXT` (full dispatch context as JSON, including the typed
claude-code-parity payloads) in its environment. Verdict contract (matches
Claude Code hooks):

- exit code `2` → **block** (stdout is the reason),
- stdout containing `{"decision":"block","reason":"…"}` JSON → **block**/**ask**,
- anything else → allow (errors fail-open unless `failOpen: false`).

### HTTP action

```jsonc
{ "type": "http", "url": "https://ci.internal/hooks", "timeoutMs": 5000 }
```

The full dispatch context is POSTed as JSON; a response body
`{"decision":"block","reason":"…"}` blocks. Non-2xx fail-open (recorded).

## Runtime wiring

`ReActAgentConfig.hooks` accepts any `HookDispatcher`; the shipped
`HookManager` implements depth-guard (max re-entrancy 2), per-rule cooldown,
dedup window and fail-open semantics:

```ts
import { HookManager } from '@ghita/agents';

const manager = HookManager.fromFile('.ghita/hooks.json');
const agent = createReActAgent({
  config: { name: 'main', tools, hooks: (ctx) => manager.dispatch(ctx) },
  llmCall,
});
```

A `block` outcome on `PreToolUse` stops the tool exactly like a policy deny —
the model receives `Hook blocked tool "<tool>": <reason>` as the observation
(wrapped in an untrusted envelope, see Track 1.4).
