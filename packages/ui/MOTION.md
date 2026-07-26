# Motion (`@workbench/ui`)

Shared Framer Motion helpers aligned with design tokens in `src/styles.css`:

| CSS variable | Export                              | Use                              |
| ------------ | ----------------------------------- | -------------------------------- |
| `--spring`   | `SPRING_EASE`, `springTransition()` | Staggered reveals, spring settle |
| `--ease`     | `EASE_CURVE`, `easeTransition()`    | Panels, popovers                 |

## Reduced motion

Factories accept a `reduceMotion` flag (from `useReducedMotion()` in Framer) and return **empty props** so callers can spread onto `motion.*` without branching layout:

- `motionPropsWhen(reduce, props)`
- `popupPanelMotion(reduce)` — floating/docked chat panels
- `crossfadePresence(reduce)` — `AnimatePresence` crossfades
- `staggerSlideIn(reduce, index)` — checklist rows

## Stagger

- **Variants:** `staggerContainerVariants` + `staggerItemVariants` for parent/child `variants` props.
- **Manual lists:** `staggerItemTransition(index)` for per-row `transition.delay`.

## Reveal

- `revealUp` — opacity + vertical shift for enter/exit.

## `AnimatedNumber`

Springs between numeric values with `tabular-nums`. When reduced motion is on, renders a static `<span>` with no spring.

```tsx
import { AnimatedNumber, popupPanelMotion } from "@workbench/ui";
import { useReducedMotion } from "framer-motion";

const reduce = useReducedMotion() === true;
<motion.div {...popupPanelMotion(reduce)} />
<AnimatedNumber value={count} decimals={0} />
```

## Migrated surfaces

- `ComparisonView` — stagger + crossfade
- `Pagination` — `AnimatedNumber` for page/total readouts
- `ProgressChecklist` — `staggerSlideIn`
- `@workbench/chat` `FloatingChat` / `DockedChatBar` — `popupPanelMotion` (+ exit via `AnimatePresence` on `FloatingChat`)
