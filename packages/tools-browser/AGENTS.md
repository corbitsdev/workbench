# @workbench/tools-browser

Browserbase browser automation tools. Registered in the hub's tool registry as `browser_*`.

- Credential (`browserbase` provider) is resolved at tool execution time — the project ID rides on the credential's `baseURL` as `?projectId=`
- Sessions are short-lived by default (`DEFAULT_SESSION_TIMEOUT_SECONDS = 180`); keepAlive sessions extend this but burn paid browser time if abandoned
- Each tool call that needs a browser creates or reuses a CDP session; do not assume session state persists across tool calls
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
