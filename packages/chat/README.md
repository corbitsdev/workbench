# @workbench/chat

Chat UI: message thread, input, docked/floating panels, and typing indicator. Presentational — receives messages as props, emits send callbacks.

## Parts model

The message/part data model — `ChatMessage`, `Part` and its variant schemas,
`ToolCall`, `ChatImage`, `ChatAttachment`, `ChatActivity`, and the
`liftToParts` / `toolPartToCall` adapters — lives in
`@workbench/agent-core` (`packages/agent-core/src/parts.ts`), not in this
package. It moved there because `@workbench/agents` (which sits in the
sidecar's runtime closure) builds and consumes these shapes via
`convertInstanceEvents` / `composeChatMessages` / `createPartAssembler`, and
`@workbench/chat` is frontend-only — a sidecar-closure package must never
depend on it. `src/types.ts` and `src/parts.ts` here re-export the
agent-core module verbatim, so `@workbench/chat/types` and
`@workbench/chat/parts` keep resolving unchanged for the renderer and any
other web imports; only chat's UI-only types (`QuickReply`, `ChatDockState`,
`ChatOpenState`, `ChatLauncherPosition`, `ChatAgentIdentity`) are still
defined in this package.

`ChatMessage` carries an additive, optional `parts: Part[]` field alongside
the existing flat fields (`content`, `reasoning`, `toolCalls`, `images`,
`attachments`). `Part` is a discriminated union — `text | reasoning | tool |
file` — deliberately mirroring Vercel UIMessage's part discriminants (so a
future library switch is a trivial mapping), restricted to fields the
Interchange event stream can actually populate. See
`@workbench/agent-core`'s `src/parts.ts` for the exported arktype schemas
(`TextPartSchema`, `ReasoningPartSchema`, `ToolPartSchema`, `FilePartSchema`,
`PartSchema`), re-exported from this package's `src/types.ts`.

**Event → part mapping** (from `@workbench/agents`'s `convertInstanceEvents` /
`composeChatMessages`, which build `ChatMessage` from `InstanceEvent`s):

| Part        | Source                                             | Notes                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`      | `event.content` (turn) / mail `content`            | The final answer segment.                                                                                                                                                                                                                                            |
| `reasoning` | `event.reasoning` (turn only)                      | One cumulative string per turn — no per-segment boundaries, so no `providerMetadata`.                                                                                                                                                                                |
| `tool`      | `event.toolCalls[]` (turn only)                    | `id`→`toolCallId`, `name`→`toolName`, `arguments`→`input`, `label`→`label`. State: `result === undefined` → `pending`; `result` present + `isError` → `output-error` (`result`→`errorText`); `result` present + `!isError` → `output-available` (`result`→`output`). |
| `file`      | `event.attachments[]` (mail) or live `ChatImage[]` | Attachments → `url: "blob:<blobId>"` (never fetched here, resolved by the host's `resolveAttachmentUrl`); images → inline `url: "data:<mimeType>;base64,<data>"`. Both map to `file` rather than a separate "inline image" variant.                                  |

Session-level states (rate-limited, inference errors) are **not** parts —
they stay on the separate `ChatActivity` / status channel.

### Two-tier fidelity

- **Live** turns interleave these parts in true stream order (think → tool →
  think → answer), emitted by the single part-assembler (`@workbench/agents`'
  `createPartAssembler`, which populates `message.parts` directly).
- **Hydrated** turns — reloaded from the hub-client contract, which only
  ever exposes a turn's cumulative `reasoning` string and finished
  `toolCalls` array, never an ordered event log — have no interleaving left
  to recover. `liftToParts` (`@workbench/agent-core`'s `src/parts.ts`,
  re-exported from this package's `src/parts.ts`) synthesizes a deterministic
  flat layout instead: **reasoning, then tool parts in array order, then
  file parts (attachments before images), then the text part.** This
  mirrors today's flat rendering order (reasoning disclosure above the
  bubble, tool narrative above the answer, answer text last), so a settled
  live turn and a hydrated turn produce the same default transcript render
  — the fidelity difference is only observable in an expanded trace view,
  never in the default transcript.

`liftToParts` is total: it never throws for any valid `ChatMessage`, and
empty/absent fields are simply omitted rather than lifted as blank parts.
It is the single legacy lift adapter — no renderer should reimplement this
translation — and is expected to be deleted once the write path is fully
parts-native.

### Renderer (`AgentTurn` / `ActivityBlock`)

`AgentTurn` computes `message.parts ?? liftToParts(message)` once and hands
the result to `ActivityBlock`, which walks the ordered parts directly rather
than reading side `reasoning` / `toolCalls` fields. This is the only lift
call site in the renderer path.

- **Ephemeral rolling activity.** While a turn is streaming, `ActivityBlock`
  shows exactly one subtle activity line derived from the trailing part
  (`activity-label.ts`'s `deriveActivityLabel`) — never the full reasoning
  body. The label cross-fades and is debounced against a minimum display
  duration so rapid part transitions don't flicker (framer-motion,
  `useStableLabel`/`RollingLabel` in `ActivityBlock.tsx`).
- **Settled turns show outputs only.** `AgentTurn`/`ActivityBlock`
  still render the roll-up disclosure when handed a message that carries
  reasoning/tool parts, but `ChatThread` no longer hands them one once a
  turn has settled: `settled-turn-projection.ts` groups a turn's committed-segment
  agent messages by the `turnId` group key `composeChatMessages` stamps on one
  exchange's segments and its live streaming bubble (`packages/agents/src/chat-messages.ts`;
  agent-initiated mail carries no key and is never merged into a reply) and,
  once every segment is settled, projects the group to the final answer text,
  any segment carrying an embedded UI block, plus any files/attachments
  produced by any segment. A group containing a failed segment is rendered
  segment-by-segment instead of projected, keeping the failure visible. Reasoning, tool calls, and
  interstitial narration segments ("Let me look up X…") are dropped from the
  projected message entirely, so no activity block renders for a settled
  turn — the tool rows, the reasoning disclosure, and the narration bubbles
  are gone from chat. Insights → Trace is the only place the full process is
  visible; a settled turn optionally shows a subtle "View trace" link
  (`AgentTurn`'s `traceHref` prop, resolved via `ChatThread`'s
  `getTurnTraceHref`) as the escape hatch. Live turns are unaffected — each
  committed segment still renders individually with its own activity block
  while any segment of the turn is still streaming.
- **Color discipline.** `ToolNarrative.tsx` exports `toolTone(call)` — the
  single place a tool call's rendering tone (`pending | failed | settled`)
  is derived from its result/error state. A failed internal tool call never
  renders red in the transcript; red is reserved for member-actionable
  failures (see `MessageBubble`'s "Failed to send").
- `reasoning-summary.ts` (whole-string regex reasoning summarizer) is
  deleted; `activity-label.ts` derives the rolling label from the trailing
  part instead, which is possible now that parts carry real order.

## Package boundary

`@workbench/chat` is a generic view layer over `ChatMessage`/`Part` and does not re-export the
`@workbench/blocks` API (interactive workflow blocks, dock/gate helpers). Consumers that need
block types or helpers (`UIBlock`, `UIResponse`, `dockRunBlocks`, `pendingGateForRun`, etc.)
import `@workbench/blocks` directly.
