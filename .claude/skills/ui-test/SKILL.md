---
name: ui-test
description: 'Grade a live Workbench UI surface through the owner progression bugs before beauty then drop-dead gorgeous. Drives agent-browser against a running app, checks three pass/fail tiers (entity sanity and dead-button bugs, DESIGN.md beauty, Vercel/Stripe/Apple-bar gorgeousness), and produces a surface-tier-blockers-fix report. Use when asked to QA, sweep, test, or grade a UI screen, dialog, or flow before it ships or demos.'
---

# ui-test — grade a surface, don't vibe it

Adapted from [browserbase/skills ui-test](https://github.com/browserbase/skills/tree/main/skills/ui-test):
kept the adversarial stance, the before/after evidence discipline, and the
structured pass/fail markers. Replaced `browse` with **agent-browser** (our
driver), replaced generic UX heuristics with our own three gates (DESIGN.md,
consumer-language, CL-6650's tier ladder), and replaced "find any bug" with
"stop at the first tier you fail" — a surface that fails Tier 1 does not get
a beauty opinion, because a data bug undermines any beauty judgment made
around it.

Your job is to **find the reason this surface would embarrass someone in a
demo**, not confirm it renders. Every verdict below Tier 3 must cite
snapshot/screenshot evidence; a "looks fine" without a ref or a quoted
snapshot line is not a passing check, it's a skipped one.

## The three tiers (CL-6650)

Walk them in order. **Stop at the first tier the surface fails** and report
that as the tier reached — don't grade beauty on a surface that still has
data bugs, and don't grade gorgeousness on a surface that's merely tidy.

### Tier 1 — bugs (blocks everything)

- **Entity sanity**: every list contains only its own kind. A routine
  showing up in an agent list, a workbench in a skills list — a data bug,
  not a display nuance.
- **Names in name slots**: the title/name position never renders a
  description, an ID, or a template string. Check the actual text content
  of the name element, not just that *some* text is present.
- **No placeholder content**: no "Lorem ipsum", no `TODO`, no seeded fixture
  names a real user would never see (see repo's `no-customer-data-in-code`
  rule — the reverse also holds: no leaked internal fixture names in a
  screen meant to look real).
- **No dead buttons**: every visible actionable control does something
  when activated. A button wired to nothing is a Tier 1 bug even if it
  looks correct.
- **Feedback ≤100ms**: every action (click, submit, toggle) produces a
  visible state change — a spinner, a disabled state, an optimistic
  update — within 100ms. Silence after a click reads as broken even if
  the real response eventually arrives.
- **Failures name their cause**: an error state shows a human-readable
  reason and, where the app's error-sink is wired up, a `refId` a person
  could quote to support. A bare "Something went wrong" with no ref is a
  Tier 1 finding.

### Tier 2 — beauty (blocks demo-path surfaces)

Only graded once Tier 1 is clean.

- **Identity on every row**: avatar/mark + name + one-line consumer
  description — never a bare name floating with no visual identity, never
  an ID standing in for a description.
- **Spacing per DESIGN.md**: tight, not loose. Loose spacing is a defect
  per standing owner rule, not a style preference — see
  `always-tighten-spacing`.
- **Consistent loading treatment**: no blank panes while data resolves, no
  overlapping chrome (a skeleton and real content both mounted at once), no
  layout jump when content lands.
- **Consumer language only**: copy speaks the user's world
  ("Running now," a cron rendered as "every weekday at 9am"), never the
  system's internals ("in flight," a raw cron expression, an enum value
  leaking into a label).

### Tier 3 — drop-dead gorgeous (the differentiator)

Only graded once Tier 2 is clean. This tier is a judgment call, not a
checklist — but the judgment must be argued, not asserted.

- **The side-by-side test**: screenshot the surface, then ask — if a
  viewer put this next to OpenBot or another agent-desktop competitor,
  would they say "that's better"? Name the specific thing that would make
  them say it, or the specific thing that would make them say the
  opposite.
- **Motion earns its place**: transitions encode a real state change
  (something entering, transforming, focus moving) — durations in the
  150–300ms DESIGN.md range, easing from the two named curves. Motion that
  could be deleted without losing information is decoration, not gorgeous.
- **States feel alive**: presence dots, typing indicators, live status —
  anything idle-looking that should read as active is a Tier 3 miss.
- **Zero "is it working?" moments**: no point in the flow where a person
  would pause and wonder whether their action registered.

Report Tier 3 as **reached with notes**, not pass/fail — it's the
differentiator tier, so name what's already gorgeous and what's one step
short, rather than a binary verdict.

## Driving the surface: agent-browser

Use a named session for the whole run — never the shared default session,
which other agents and the human may be using concurrently:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix uitest)"
```

(Per CL-6650's acceptance run, `--session uitest` is also acceptable when a
literal fixed name is asked for — either way, name it, don't use the
default.)

Core loop — identical discipline to the upstream skill, our driver:

```bash
agent-browser open <url>
agent-browser snapshot -i          # interactive elements only
agent-browser click @e3            # act on a ref from the snapshot just taken
agent-browser snapshot -i          # re-snapshot — refs go stale the instant the page changes
```

Log in once per run if the surface requires auth, then re-use the session
for every subsequent check rather than re-authing per tier.

### The stale-match trap (read this before grepping a snapshot)

**Never `grep`/search a whole-page snapshot for the text you're checking.**
A full snapshot includes every region on screen at once — sidebar bench
previews, a notifications panel, a command palette residue — and Workbench
intentionally echoes short strings (a bench's first message, an agent's
name) into more than one place. A grep over the entire tree will match a
sidebar preview and report a false pass ("found the name") when the actual
timeline or dialog you're grading still shows the bug.

Always scope the assertion to the specific region under test:

```bash
# Wrong: matches anywhere on the page, including the sidebar's bench preview
agent-browser snapshot -i | grep "Jimmy"

# Right: scope to the region that actually renders the thing under test
agent-browser snapshot -i -s "[role=dialog]"        # a modal/dialog
agent-browser snapshot -i -s "[data-testid=timeline]"  # the conversation timeline
agent-browser snapshot -i -s "#main"                 # the page body, excluding the sidebar
```

If the surface has no stable selector for its region, screenshot it and
verify the specific row/element visually rather than trusting a
whole-tree text match. When in doubt, take a narrower snapshot, not a
wider grep.

### Evidence per finding

Every claim in the report — pass or fail — cites one of, in order of
rigor:

1. A scoped snapshot line with its `@eN` ref and exact text.
2. A before/after pair of scoped snapshots showing what changed.
3. A screenshot (`agent-browser screenshot <path>`), for visual-only
   properties a snapshot can't capture (spacing, color, motion).

Save screenshots to `.context/ui-test-screenshots/<surface>-<finding>.png`.

## Running the sweep

1. **Confirm the target renders.** `agent-browser open <url>`, then a
   scoped snapshot of the main region — not an error overlay, not a blank
   body.
2. **Walk Tier 1 first**, end to end, on the whole surface. Any failure:
   stop, that's the tier reached.
3. **If Tier 1 is clean, walk Tier 2.** Any failure: stop, that's the tier
   reached — note it still blocks if this is a demo-path surface.
4. **If Tier 2 is clean, walk Tier 3** and write it up as judgment with
   evidence, not pass/fail.
5. **Write the report** (format below).
6. `agent-browser close` when done with the session.

## Report format

```
## UI Test — <surface name>

**Tier reached:** <1 (bugs) | 2 (beauty) | 3 (gorgeous)>
**URL:** <url>
**Session:** <session name>

### Blockers
1. <one-line description of the bug>
   - Evidence: <scoped snapshot ref/line, or screenshot path>
   - Smallest fix: <the smallest change that would clear this, named at
     the file/component level if known, otherwise the behavior that must
     change>

2. ...

### Tier 3 notes (only if Tiers 1–2 are clean)
- What already clears the Vercel/Stripe/Apple bar: ...
- What's one step short, and what would close the gap: ...

### Passed checks
- <tier> — <check> — <evidence>
```

List blockers before passed checks — a reviewer needs the bad news first.
A surface with zero Tier 1 or Tier 2 blockers still gets its passed
checks listed, so the report proves the tiers were actually walked rather
than skipped.

## References

- [references/agent-browser-recipes.md](references/agent-browser-recipes.md) —
  copy-paste command patterns: sessions, scoped snapshots, deterministic
  checks (console errors, broken images), screenshot capture.
- [references/regression-seeding.md](references/regression-seeding.md) —
  how to seed a known regression locally to verify the skill actually
  catches it, per CL-6650's acceptance criteria.

## Troubleshooting

- **Stale refs**: re-`snapshot` — refs are assigned fresh every time and
  go stale the moment the page changes.
- **Blank snapshot**: `agent-browser wait --load networkidle` before
  snapshotting; Workbench routes can return 200 with a still-mounting
  shell.
- **Session collision**: make sure every command in the run uses the same
  `AGENT_BROWSER_SESSION` (or `--session <name>`) — a command without it
  falls back to the shared default session.
- **Can't tell if a match is the real region or a stale sidebar echo**:
  narrow the snapshot's `-s` selector further, or fall back to a
  screenshot and look at it.
