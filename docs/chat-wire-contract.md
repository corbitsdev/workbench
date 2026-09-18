# Chat wire contract

`apps/web/src/chat/wire/*` is the browser-facing half of the wire contract
also implemented server-side in `packages/chat/src`. `apps/web` cannot import
`@corbits/chat` — a server-only package — so this half is hand-mirrored
rather than shared by import. Once the hub moves onto native mail threads,
`packages/chat`'s copy goes away and this becomes the one source of truth.

Keep both sides in sync by hand until then; a schema or type added to one
side belongs on the other.

## Internal-id leak guard

`chat/wire/id-leak-guard.ts` centralizes the check that a person never sees
an internal identifier (a raw `run_…`/`wfd_…`/etc., or `humanizeSlug`'s
Title-Cased reading of one, e.g. "Run 737a058d…"). This recurred repeatedly
as one-off display-time patches (insights, a Myra reply, a chat title)
before being consolidated here, so a new id-generating prefix is a missed
test run rather than a missed grep. Prefix words mirror `@intx/hub-common`'s
`generateId` (`PREFIXES` in `packages/hub-common/src/ids.ts`).

## Approve block (`chat/blocks/approve-block.tsx`)

The card renders the platform's own live account of what's being asked as
the authoritative description next to Approve/Deny; an agent's own framing
is demoted to contextual color and never shown alone. Resolved state is
always re-rendered from the host's status read, never from the block's own
data or a decision response the card just made — nothing here is itself a
decision.

`@/chat` owns no session or query cache and never fetches/mutates approvals
itself — the host supplies an `ApprovalActions` port (`chat/blocks/approval-
actions.ts`), calling the same native approve/reject routes and
invalidating the same query keys as Inbox, so the card, Inbox, and the
Activity band stay one source of truth. `forbidden` is distinct from
`canAct: false`: it means the host's own status read was refused, so the
card shows Approve/Deny anyway and lets the real decision call's own
authorization decide, rather than guessing a verdict or rendering
unverified agent text as the platform's account of the request.

## Stream events (`chat/wire/stream-events.ts`)

Organizing rule: a subscriber must be able to render, or update its own
state, from the event alone — never a follow-up GET. `chat.message` carries
the full rendered row (mail headers included, when the row was actually
mailed); `chat.presence` deltas fold into the roster `chat.presence.snapshot`
already gave the connecting stream.

## Classified inference failures (`chat/inference-failure.ts`)

By the time a reply reaches the chat timeline it is a plain text part with
no metadata — the failure's category is structured further upstream
(`packages/chat`'s orchestrator reads it directly), but nothing carries it
down to this render layer. So this file matches reply prose against the
exact preambles `@intx/inference`'s `formatInferenceError` writes for
`credential_failure` and `quota_exhausted`, anchored at the start of the
string (never a substring, so a reply that quotes one mid-sentence can't
false-positive). A test asserts the preambles stay byte-for-byte identical
to the vendored source they're copied from.
