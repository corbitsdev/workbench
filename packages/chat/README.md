# @workbench/chat

Chat UI: message thread, input, docked/floating panels, and typing indicator. Presentational — receives messages as props, emits send callbacks.

## Parts model

`ChatMessage` carries an additive, optional `parts: Part[]` field alongside
the existing flat fields (`content`, `reasoning`, `toolCalls`, `images`,
`attachments`). `Part` is a discriminated union — `text | reasoning | tool |
file` — deliberately mirroring Vercel UIMessage's part discriminants (so a
future library switch is a trivial mapping), restricted to fields the
Interchange event stream can actually populate. See `src/types.ts` for the
exported arktype schemas (`TextPartSchema`, `ReasoningPartSchema`,
`ToolPartSchema`, `FilePartSchema`, `PartSchema`).

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
  to recover. `liftToParts` (`src/parts.ts`) synthesizes a deterministic
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
- **Settled turns** show a roll-up summary (`"Worked · N tools"`-style, via
  the host's `summarizeCalls`) behind the same collapsible disclosure —
  the full trace remains reachable on expand for now; Insights → Trace is
  the canonical place for deep inspection.
- **Color discipline.** `ToolNarrative.tsx` exports `toolTone(call)` — the
  single place a tool call's rendering tone (`pending | failed | settled`)
  is derived from its result/error state. A failed internal tool call never
  renders red in the transcript; red is reserved for member-actionable
  failures (see `MessageBubble`'s "Failed to send").
- `reasoning-summary.ts` (whole-string regex reasoning summarizer) is
  deleted; `activity-label.ts` derives the rolling label from the trailing
  part instead, which is possible now that parts carry real order.
