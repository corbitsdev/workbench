# @corbits/shell-layout

The generic shell mechanics a second Interchange deployment needs to
compose its own shell frame (sidebar, main stage, canvas) without
inheriting workbench's product policy. This package owns state machines
and hooks; the host app owns what its sidebar lists, which routes exist,
and the concrete types its canvas renders.

## What a host app injects

**Canvas profile and artifact types** — `CanvasColumnState<TProfile,
TArtifact>` and its transition functions (`openProfileInCanvas`,
`openArtifactInCanvas`, `closeCanvasContent`, `toggleCanvasFocus`, …) are
generic over whatever a host's canvas renders:

```ts
import {
  initialCanvasColumnState,
  type CanvasColumnState,
} from "@corbits/shell-layout";

type HostProfile = { id: string; displayName: string };
type HostArtifact = { id: string; title: string; body: string };

const [state, setState] = useState<
  CanvasColumnState<HostProfile, HostArtifact>
>(initialCanvasColumnState<HostProfile, HostArtifact>);
```

This package never imports the host's concrete subject or artifact
types — it only ever touches `.profile`/`.artifact` as opaque `TProfile`/
`TArtifact` values.

**Breakpoint config** — `shellLayoutModeForWidth`/`shellLayoutModeFromMatches`
take raw pixel widths; the compact/narrow thresholds (`COMPACT_MAX_WIDTH`,
`NARROW_MAX_WIDTH`) are exported constants a host can read but not
override — one breakpoint contract for every consumer. The one per-mode
column rule is `canvasColumnAllowed` (the canvas needs "expanded"); the
sidebar is always present and has no mode rule.

**Dialog-request handling** — `createPendingDialogRequest()` returns an
isolated `{ request, consumePending, resetPending }` instance per call; a
host wires its own dialog trigger and target-route mount effect around it
(see `command-palette-actions.ts` / the target page's mount effect for the
pattern).

## What this package never knows about

- **Routes.** No route table, no path constants.
- **Sidebar content.** What the sidebar lists is 100% host policy.
- **Workbench's concrete types.** `ProfileSubject` (`@corbits/chat-ui`) and
  `ArtifactRendererKind` (`@corbits/artifact-ui`) are never imported here;
  the canvas state machine is generic precisely so a different host can
  plug in its own subject and artifact shapes.

## Modules

| Module                      | Owns                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `breakpoints.ts`            | Pixel-width → `ShellLayoutMode` and the canvas's mode rule |
| `use-shell-layout.ts`       | The `matchMedia`-driven hook reading those breakpoints     |
| `canvas-column-state.ts`    | The canvas's open/profile/artifact/focus state machine     |
| `use-scroll-reset.ts`       | Per-route scroll reset                                     |
| `pending-dialog-request.ts` | The cross-route "open this dialog" pattern                 |

## Where the workbench build's concrete types live

`apps/web/src/shell/canvas-availability.tsx` defines this app's
`CanvasArtifactContent` (with `rendererKind: ArtifactRendererKind`,
`canEdit`, …) and instantiates `CanvasColumnState<ProfileSubject,
CanvasArtifactContent>` as `AppCanvasColumnState` — the one place workbench
policy meets this package's generic mechanism. A different host defines
its own equivalent file with its own types.

## Running tests

```
cd packages/shell-layout && bun test
```

Some suites mount into a real DOM (see `test/dom-setup.ts`); running from
the package directory picks up `bunfig.toml`'s preload.
