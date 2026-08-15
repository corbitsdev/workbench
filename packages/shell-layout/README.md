# @corbits/shell-layout

The generic shell mechanics a second Interchange deployment needs to
compose its own four-column shell (rail, contextual panel, main stage,
canvas) without inheriting workbench's product policy. This package owns
state machines and registries; the host app owns which panels exist, which
routes are wide, and the concrete types its canvas renders.

## What a host app registers or injects

**Panel contributions** — a host registers one `PanelContribution` per
route family; the contextual panel resolves the first match for the
current path and renders its band:

```ts
import { registerPanelContribution } from "@corbits/shell-layout";

registerPanelContribution({
  id: "channels",
  match: (path) => path.startsWith("/c"),
  pageBand: (ctx) => ({ title: "Channels" }),
  pageSpecific: (ctx) => <ChannelsBand path={ctx.path} onNavigate={ctx.onNavigate} />,
});
```

The registry only knows `id`/`match`/`pageBand`/`pageSpecific` — it never
knows which panels exist or what routes a build has; that list lives in
the host's own module that calls `registerPanelContribution`
(`apps/web/src/shell/panel-contributions.tsx` in this repo).

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
override — one breakpoint contract for every consumer.

**Pin storage** — `loadPins`/`savePins` read and write a `Pin` (`{ id,
kind, label, href }`) list through a host-supplied `Storage`-shaped object
_and_ a host-supplied storage key, both required with no default — so two
hosts (or a host and its own tests) can never collide on a shared,
package-branded key, and a host can pass a test double or a different
persistence layer without forking the module:

```ts
import { loadPins, savePins } from "@corbits/shell-layout";

const PINS_KEY = "myhost.shell.pins";
const pins = loadPins(localStorage, PINS_KEY);
savePins(nextPins, localStorage, PINS_KEY);
```

`togglePin` is pure list math and takes no storage at all.

**Dialog-request handling** — `createPendingDialogRequest()` returns an
isolated `{ request, consumePending, resetPending }` instance per call; a
host wires its own dialog trigger and target-route mount effect around it
(see `command-palette-actions.ts` / the target page's mount effect for the
pattern).

## What this package never knows about

- **Routes.** No route table, no path constants beyond what a host passes
  into `match`/`pageBand` callbacks.
- **Which panels exist.** Only the registry mechanism — registration
  itself is 100% host policy.
- **Band or product policy.** Which route is "wide", which page gets which
  band, what a pin points at — all host-side decisions.
- **Workbench's concrete types.** `ProfileSubject` (`@corbits/chat-ui`) and
  `ArtifactRendererKind` (`@corbits/artifact-ui`) are never imported here;
  the canvas state machine is generic precisely so a different host can
  plug in its own subject and artifact shapes.

## Modules

| Module                      | Owns                                                          |
| --------------------------- | ------------------------------------------------------------- |
| `panel-contribution.ts`     | The contribution registry (register/resolve/list)             |
| `breakpoints.ts`            | Pixel-width → `ShellLayoutMode` and its per-mode column rules |
| `use-shell-layout.ts`       | The `matchMedia`-driven hook reading those breakpoints        |
| `canvas-column-state.ts`    | The canvas's open/profile/artifact/focus state machine        |
| `stage-chrome.tsx`          | Col2's collapse/width state and its React context             |
| `focus-rescue.ts`           | Keyboard focus rescue across a layout-mode change             |
| `use-scroll-reset.ts`       | Per-route scroll reset                                        |
| `pins.ts`                   | The global pins list (load/save/toggle)                       |
| `pending-dialog-request.ts` | The cross-route "open this dialog" pattern                    |

## Where the workbench build's concrete types live

`apps/web/src/shell/canvas-availability.tsx` defines this app's
`CanvasArtifactContent` (with `rendererKind: ArtifactRendererKind`,
`canEdit`, …) and instantiates `CanvasColumnState<ProfileSubject,
CanvasArtifactContent>` as `AppCanvasColumnState` — the one place workbench
policy meets this package's generic mechanism. A different host defines
its own equivalent file with its own types.
