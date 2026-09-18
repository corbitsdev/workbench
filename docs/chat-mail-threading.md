# Chat and workbench mail threading

`apps/web/src/chat/threads-api.ts` is the only seam between the chat UI and
mail: a chat has exactly one agent, and both sides are durable mail — the
person sends from their own mailbox (keeping a Sent copy), and an agent's
reply lands in the same mailbox's INBOX. No chat-specific hub route exists.

A chat is keyed by its agent's definition asset id, not a run id: every hub
restart releases the old run and redeploys under a new one, so keying on a
run id would 409 the moment it turns terminal. An agent's address set spans
every run it has ever had, which keeps history intact across a redeploy;
sends resolve the current live run's address at send time.

A workbench is a child tenant, and its conversation is that tenant's own
mailbox — reads are the same stock mailbox routes as a chat, scoped to the
child tenant id.

## Workbench send roster

`sendToWorkbench` appends a trailing roster of every participant's name and
address to the message body (the same rows the Participants panel reads).
The hub only delivers to a run address, which only the client otherwise
knows, so this is what lets an agent hand a task to another agent in the
workbench. The mail tools have no `cc` field, so the roster also tells
agents to copy the person on a handoff by naming them as another `to`
recipient.
