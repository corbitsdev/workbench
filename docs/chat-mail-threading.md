# Workbench mail threading

A workbench is a child tenant, and its conversation is that tenant's own
mailbox — reads and sends go through the stock mailbox routes scoped to
the child tenant id. No workbench-specific hub route exists.

## Workbench send roster

`sendToWorkbench` appends a trailing roster of every participant's name and
address to the message body (the same rows the Participants panel reads).
The hub only delivers to a run address, which only the client otherwise
knows, so this is what lets an agent hand a task to another agent in the
workbench. The mail tools have no `cc` field, so the roster also tells
agents to copy the person on a handoff by naming them as another `to`
recipient.

## Mentions

A message with no `@Name` token fans out to every live agent in the
workbench. Typing `@` in the composer opens a roster popover; choosing an
agent inserts its name as a plain token, which `mentionedAgents` reads back
at send time to narrow the `to` list to just those agents. The token stays
in the body so the agent sees who was addressed, and the roster block is
still appended in full, so a narrowed message can still be handed on.

## A person's address is lowercase

A person's address is their auth user id at the workbench domain, and that
id is mixed case. Small models lowercase an address before replying, so
`personMailAddress` lowercases it at every point the client derives one —
the roster, the Participants panel, a schedule's body — and the hub stamps
the same lowercase form on a person's outbound mail. Mailbox delivery
matches the local part case-insensitively, so both forms reach the same
inbox: threads written before this keep their mixed-case addresses, new
mail carries the lowercase one, and nothing is migrated.

## Primary-thread root resolution

`readHubSnapshot`'s caller resolves a workbench's primary-thread root from
the recorded `primaryThreadMessageId`, falling back to `mail[0]` only for
mail sent before that id existed. The mailbox list is assumed oldest-first;
if the hub ever returns newest-first or unordered rows the fallback
mistargets, so the recorded id stays authoritative.

## Sub-thread fork replay

`forkSubThread` treats a fork as already sent when parent + subject +
recipients + body match a recorded row, returning its native Message-ID
instead of resending. Rows recorded before recipients/body were stored
match on parent + subject only, to preserve their exactly-once replay.
