# ACP integration

Slackboard uses the official TypeScript SDK `@agentclientprotocol/sdk@2.2.0` with the stable ACP v1 entrypoint. Protocol reference: <https://agentclientprotocol.com/protocol/v1/overview>.

## Connection lifecycle

1. Spawn the configured executable and argument array without a shell. The agent's working directory is the session workspace.
2. Open newline-delimited JSON-RPC over the child's stdin/stdout. Stderr is captured separately in a bounded ring buffer and never mixed into the protocol stream.
3. Send `initialize` with protocol version 1 and only the client capabilities actually implemented: `fs.readTextFile`, `fs.writeTextFile`, `terminal`, and `session.notices`. Terminal authentication and elicitation are not advertised.
4. Reject a protocol version other than 1.
5. Create a session with `session/new`, or reload an existing session only when the agent advertises `loadSession` / `session/resume`.
6. Prompt with text content blocks. Stream `session/update` notifications into ordered events. Ignore and never publish `agent_thought_chunk`.
7. `session/cancel` on cancel/stop, then terminate the subprocess after a bounded grace period.

An unexpected process exit is reported as an interrupted/failed turn; Slackboard never replays a potentially side-effecting turn automatically.

## Capability gates

The dashboard and Slack surface unsupported features explicitly. Slackboard only:

- calls `session/load` when `loadSession` is advertised
- calls `session/resume`/`session/close` when the matching `sessionCapabilities` are advertised
- passes `additionalDirectories` when advertised
- passes HTTP/SSE MCP servers when the matching `mcpCapabilities` are advertised
- presents ACP permission options exactly as reported
- offers agent modes and commands from agent updates rather than inventing them

If an agent advertises neither load nor resume, a new session is created. The user is explicitly told that it is not a resumed session, and the new prompt is seeded with a labelled transcript excerpt.

Authentication that needs a browser or interactive terminal is an operator setup step. Slackboard exposes auth method names in the doctor and session events but never publishes credentials or authentication URLs to Slack.

## Filesystem callbacks

`fs/read_text_file` and `fs/write_text_file` are implemented by the client, not the agent:

- all paths must be absolute
- the resolved real path must be inside the session workspace root
- symlink escapes are rejected for reads
- writes through a final-component symlink are rejected
- writes use a temporary file and rename; content and read sizes are bounded
- writes outside the root or through an unresolved parent are rejected
- missing files return ACP `-32002`; invalid paths return `-32602`

The local runner cannot sandbox an agent with direct shell access. Container mode provides process isolation; it is still not a guarantee against a malicious agent binary.

## Terminal callbacks

`terminal/create`, `output`, `wait_for_exit`, `kill` and `release` are implemented with:

- cwd containment checks
- an environment-variable blocklist for loader/interpreter/proxy changes
- bounded retained output, truncated from the beginning at a UTF-8 boundary
- process-group termination on local mode and container removal on stop
- a per-session terminal limit

## MCP

MCP servers are stored as transport declarations and environment/header *references*. Values are resolved only at session creation. Unsupported transports or missing referenced variables produce a visible session warning instead of silently pretending the server was attached. Stdio commands must be absolute paths.

## Connection doctor

The doctor spawns the agent, completes `initialize`, and reports:

- executable and argument array
- protocol version and self-reported agent info
- negotiated capabilities and unsupported features
- advertised auth method names and types
- stderr tail on failure

It does not authenticate, create a session or prompt. `agentInfo` is self-reported and is never used for security decisions.

## Compatibility status

| Agent | Invocation | Version | Verified here |
| --- | --- | --- | --- |
| Built-in fake ACP fixture | Node fixture in `tests/fixtures` | local | yes, protocol integration tests |
| Any real agent | operator-supplied | unknown | no — credentials/binaries unavailable |

The fake fixture exercises streaming, tool calls, plans, commands, notices, permission choices, rejection of unoffered options, cancellation, crash, auth-required, session load, session replacement, filesystem containment, terminals and malformed stdout.

Slackboard does not claim universal ACP feature parity and does not implement remote ACP transports. Each real agent must be checked with the doctor and a smoke session. Named presets are intentionally absent until exact invocations are verified.
