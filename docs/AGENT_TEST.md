# Agent Test Program

A graduated series of live tests an agent (or a person) runs against a real
Workbench stack to validate that agents actually work — not that CI is
green. Every level is a checklist with pass criteria and an evidence rule.
Levels build on each other: do not certify a level until every level below
it holds on the same build.

**Ground rules**

- Run against a real inference provider. We use Ollama on a remote box;
  the provider is interchangeable — the program is not.
- Drive the real UI (`agent-browser`) or the real API, never internals.
  Follow `.claude/skills/ui-test` for evidence discipline: scoped
  snapshots, reproduce twice, timings noted.
- Model latency is not failure. UI dishonesty about latency is.
- Every failure gets a Linear ticket with the exact repro; every pass is
  stated plainly. Silence is the only unacceptable outcome — from the
  product or from the tester.

## L0 — The loop

The baseline that everything else assumes.

- [ ] Fresh signup → connect a provider → first workbench → send a
      message → the agent replies. One sitting, no seed accounts.
- [ ] The reply is clean: no raw chain-of-thought, no internal package
      paths, no protocol strings.
- [ ] A failed turn says why, carries a reference id, and Retry resends
      without touching the composer.
- [ ] Restart the stack. The same room answers again without recreating
      anything.

## L1 — Concurrency and queuing

Multiple messages, one room. The product must never lose or misattribute
a turn; honest queuing beats silent dropping every time.

- [ ] Same user sends 3 messages rapid-fire before any reply lands. All
      are answered (batched or serial), none lost, order legible.
- [ ] Two users (two browser sessions) message the same agent
      simultaneously. Both get answers; attribution is correct.
- [ ] **One agent, five people**: five sessions message one agent within
      seconds. Expected: turns queue per agent; every sender either gets
      an answer or an honest notice. Measure: time-to-first-feedback for
      the 5th sender; nothing silently >120s (turn deadline).
- [ ] While an agent is generating, send it another message. The second
      turn queues; the first reply still lands intact.
- [ ] Typing indicators are per-agent and truthful: they show while a
      turn is running, clear when it ends, and never show for an idle
      agent.

## L2 — Multi-agent coordination

Several agents, one room. The room must stay legible.

- [ ] @A a question; while A generates, @B another. **Both replies
      land**, attributed correctly (the CL-6670 class).
- [ ] Un-addressed message in a multi-agent room: behavior is predictable
      and documented (host answers). A new user could guess it.
- [ ] Three or more agents: header identity, distinct typing indicators,
      no interleaving confusion in the timeline.
- [ ] **Agent↔agent mail dispatch**: agent A asks agent B for something
      through the platform (mail), B's answer reaches A, and the room
      shows enough of the exchange that a human can follow the work.
- [ ] Tag-dispatch fan-out: one message @-ing two agents produces two
      attributed replies, not one merged or dropped.

## L3 — Routines

Scheduled and triggered work, including agents building it.

- [ ] Create a routine in the UI; Run now; the result lands where
      promised and the run's status reaches a terminal state everywhere
      it is shown (list, detail, Mission Control, Insights) — no
      eternal "Running now".
- [ ] Schedule a routine (near-future cron); it fires unattended.
- [ ] **An agent creates a routine** from a chat instruction ("check X
      every morning and post here"); the routine exists, is visible,
      correctly configured, and fires.
- [ ] An agent edits/disables a routine on request.
- [ ] A routine that needs a missing capability fails with a named,
      actionable reason — never a silent no-op.

## L4 — Capabilities: plugins, skills, tools

Agents extending what they can do.

- [ ] **Plugins pull-in**: an agent uses an already-connected plugin
      (e.g. posts a GIF via Giphy) without ceremony.
- [ ] **Plugin recommendation**: asked to do something requiring an
      unconnected plugin, the agent recommends connecting it by name and
      the connect flow is one click away — credentials are collected
      BEFORE the capability is exercised, per the guided-join rule.
- [ ] Agent-declared slash commands register on join and vanish on leave
      (`/gif`, `/jimmy`).
- [ ] **Auto-creating skills**: ask an agent to capture a working method
      as a skill; the skill exists, is versioned, pinned to the agent,
      and demonstrably changes behavior on next use.
- [ ] **Creating tools**: where tool authoring is exposed, an agent
      drafts a tool, the human approves, and the tool is callable. Every
      external side effect sits behind approval — verify the approval
      actually gates.

## L5 — Agent lifecycle

Creating and changing agents, and the changes actually taking effect.

- [ ] Create an agent (model, prompt) in the UI; invite; it answers in
      character. One click = one agent (no duplicate records).
- [ ] **Update an agent's instructions**; the next reply in an existing
      room obeys the edit (reconcile-on-wake — the CL-6588 class). Other
      rooms pick it up on their next turn.
- [ ] Change an agent's model; verify the switch took (ask it to
      identify; check Insights attribution).
- [ ] Create an agent on every chat-capable catalog model; each replies.
      Non-chat models never appear in the picker.
- [ ] Delete/archive an agent: rooms show an honest state, history
      preserved, no undead participant.

## L6 — Memory and self-improvement

Per-bench learning. Myra should get better at _this_ bench.

- [ ] Tell an agent a durable fact ("our fiscal year starts in Feb").
      New conversation, same bench: the fact is used without re-telling.
- [ ] Memory is inspectable: a person can see what the bench remembers
      (read-only surface) and it matches what was taught.
- [ ] **Myra self-improvement per bench**: after correcting Myra's
      behavior twice ("always answer in bullet points here"), the third
      ask complies without the correction. Verify the mechanism is
      per-bench: another bench's Myra is unaffected.
- [ ] Memory survives stack restart and agent sleep/wake.
- [ ] Memory respects boundaries: nothing from bench A surfaces in
      bench B; nothing from tenant A surfaces in tenant B.

## L7 — Instrumentation: insights and evals

The system's account of itself must be true.

- [ ] **Insights**: after a known workload (e.g. exactly 5 turns across
      2 agents), turn counts, per-workbench breakdowns, latency, and
      token numbers reflect it. Local models may honestly show $0 cost;
      zeros anywhere else must trace to a real reason, not a broken
      projection.
- [ ] Run detail/trace pages agree with the room: a delivered reply's
      run shows terminal, its steps visible.
- [ ] **Evals**: run an eval against an agent (when shipped); results
      are reproducible run-to-run within stated variance; an empty evals
      surface says so honestly rather than implying data.
- [ ] Mission Control's numbers agree with each other and with Insights
      for the same window.

## Cadence

- **Per merge wave**: re-run the levels the changes touch.
- **Per release candidate**: full L0–L7 on one build, one sitting.
- **Grow the list**: every production incident adds its repro here as a
  permanent checklist line (this file is the regression memory of the
  agent platform).
