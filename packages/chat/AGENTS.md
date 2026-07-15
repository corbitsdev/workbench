# @workbench/chat

Chat UI components: message thread, input, typing indicator, docked and floating panels. Renders conversation state from `@intx/agent` message types — no data fetching here.

- `MessageBubble` renders a single message; skip rendering if content is empty and not streaming
- Styling uses `packages/ui/src/styles.css` design tokens — no inline Tailwind magic values
- No direct hub API calls; the parent app owns the transport layer

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
