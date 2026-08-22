# agent-browser recipes for ui-test

Copy-paste patterns for the checks SKILL.md calls out. Load `agent-browser
skills get core --full` for the full command reference if a pattern here
doesn't cover what you need — this file only holds the ui-test-specific
subset.

## Session setup

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix uitest)"
agent-browser open http://localhost:3000
```

Or a fixed literal name when a run needs to be resumable across commands:

```bash
agent-browser --session uitest open http://localhost:3000
```

Always `agent-browser close` (or `close --all` if you opened more than one
tab/context) at the end of a run.

## Scoped snapshots (the stale-match trap, operationalized)

```bash
# Whole page — use only to orient yourself at the start of a run
agent-browser snapshot -i

# A dialog/modal under test
agent-browser snapshot -i -s "[role=dialog]"

# The conversation timeline, not the sidebar's preview of the same bench
agent-browser snapshot -i -s "[data-testid=timeline]"

# The page body, explicitly excluding the sidebar
agent-browser snapshot -i -s "#main"
```

If the surface has no `data-testid`, scope by the nearest stable
landmark role (`snapshot -i -s "[role=main]"`, `-s "form"`) before
falling back to a screenshot.

## Before/after comparison

```bash
agent-browser snapshot -i -s "[role=dialog]"     # BEFORE
agent-browser click @e4                          # ACT
agent-browser snapshot -i -s "[role=dialog]"     # AFTER — compare, don't assume
```

## Feedback-latency check (Tier 1: actions acknowledged ≤100ms)

There is no built-in stopwatch — approximate it by snapshotting
immediately after the action and checking whether *any* visible change
(disabled state, spinner, optimistic row) is already present, versus a
`wait --text` call to see how long the real change takes to land:

```bash
agent-browser click @e4
agent-browser snapshot -i -s "[role=dialog]"   # should already differ from BEFORE
```

If the immediate snapshot is byte-identical to BEFORE, that's a Tier 1
finding regardless of whether the eventual result is correct.

## Deterministic checks

```bash
# Console errors since the page loaded
agent-browser eval "window.__uitestErrors ?? []"   # if the app exposes a hook; otherwise:
agent-browser eval "Array.from(document.querySelectorAll('img')).filter(i => i.naturalWidth === 0).map(i => i.src)"
```

## Screenshot evidence

```bash
mkdir -p .context/ui-test-screenshots
agent-browser screenshot .context/ui-test-screenshots/<surface>-<finding>.png
```

Take the screenshot at the moment of failure, not after any recovery
click. For Tier 3 visual judgment (spacing, motion, color), screenshot
the surface even when nothing is "wrong" — the report cites it as
evidence for the gorgeous-tier argument either way.
