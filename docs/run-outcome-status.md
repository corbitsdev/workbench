# Run outcome status

Notes on `@corbits/workflows`'s `schedule/run-outcome.ts`: how a platform
run's raw `status` column becomes what a surface should show.

## Why this exists

Warm-keep leaves a fire's delivery agent deployed after it replies, so
`workflow_run.status` never settles out of `running` on its own. Insights,
Mission Control, and the shell activity feed all read a listing-shaped
payload through this module rather than badging the raw column, so a
lingering `running` status past `FIRE_RUNNING_WINDOW_MS` reads as completed
instead of still in flight. This logic was originally
`@corbits/routines`'s `health.ts`/`run-language.ts`, carried over verbatim
when routines cut over to native `ScheduleTrigger` definitions.

## In-flight signal and abandonment

A finished fire is supposed to land `completed`/`failed`/`cancelled` plus
`endedAt` via `markTerminal`. `FIRE_RUNNING_WINDOW_MS` is a last resort for a
fire already known abandoned that never got that write — it is never
applied to a live in-flight fire, since a tool loop can outlast ten minutes
before persist catches up.

Absent `turns`/`hasInFlightTurn` is treated as unknown, never as "no
in-flight turn." Treating an omission as empty would revert the
live-tool-loop false-complete this module exists to prevent, so a listing
row is abandoned only when the producer explicitly said there is no
in-flight turn, and the fire is older than the window.
