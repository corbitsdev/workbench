# Workbenches

A workbench is Workbench's one conversational surface: every workbench is a
multi-agent room, and there is no separate chat-vs-channel behavioral split
— a 1:1 chat and a multi-agent channel route messages the same way (see
[CHAT.md](CHAT.md) for the underlying channel/thread model).

## Host routing

`sendChannelMessage` (`packages/chat/src/channel-service.ts`) decides who
receives a message without ever branching on the channel's `kind`:

- **`@mention` an agent** — that agent always receives the message.
- **Reply to an agent's message** — that agent receives it too, even
  unmentioned.
- **Neither** — the message defaults to the workbench's **host**, its
  first agent participant. A single-agent workbench still auto-responds;
  a multi-agent one routes through its host instead of going silent.

An agent's own reply runs the same mention fan-out (`chat-orchestrator.ts`'s
`postReply`), so an agent can delegate mid-conversation by @mentioning a
teammate in its reply.

## Myra as standing host

Myra (the `assistant` default workflow, `workflows/assistant/src/index.ts`)
is the host every new workbench starts with. Her triage clause decides, on
every message, whether to answer directly or delegate: answer directly for
questions, drafting, or anything reasoned through in the conversation;
delegate — by dispatching a task to an existing agent, or by drafting and
creating a new specialist agent when none fits — for a distinct, boundable
job, especially recurring ones (draft a routine instead of being asked
each time). In a workbench with other agent teammates, Myra delegates by
@mentioning the specialist and saying why in a few words, rather than
answering on that specialist's behalf.

## Approvals

A tool gated `approval: "ask"` parks its run instead of executing: the
run's `reactor.gate.blocked` event surfaces in-chat as an approve block
(`packages/chat/src/blocks.ts`'s `ApproveBlockData`), carrying only a
platform-minted `approvalId` and the agent's framing (title, risk, body).
Deciding on the card — or through the platform's approvals API — resumes
the parked run. The orchestrator never mints an approval itself; it only
reads the row the hub's own suspension-registration co-write already
wrote.

## Routines and tasks

A routine's runs and a dispatched task's result both deliver into a
workbench rather than a separate destination: a routine's delivery lands
in its channel's delivery thread, and a dispatched task's completion or
failure posts into the channel it was dispatched from (falling back to the
tenant's assistant chat when no origin channel was recorded) — never only
an inbox. There is no standalone Inbox page; task/approval affordances live
inside the workbench itself.
