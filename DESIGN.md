# Design System — GTM Workbench

This document defines the Corbits design system, responsive approach, and component usage guidelines for the GTM Workbench web UI. It serves as the single source of truth for design tokens, theme implementation, and component decisions.

## Table of Contents

- [Design Tokens](#design-tokens)
- [Color Palette](#color-palette)
- [Typography](#typography)
- [Spacing & Layout](#spacing--layout)
- [Border Radius](#border-radius)
- [Responsive Design](#responsive-design)
- [shadcn Component Usage](#shadcn-component-usage)
- [Current Issues](#current-issues)
- [Component Refactor Checklist](#component-refactor-checklist)

---

## Design Tokens

All design tokens are defined as CSS custom properties in `packages/ui/src/styles.css` using Tailwind v4's `@theme` directive and are available globally via `:root` theme variables. There is no `tailwind.config.ts` — Tailwind v4 reads token definitions directly from CSS.

### Token Categories

| Category          | Purpose                   | Variables                                                                 |
| ----------------- | ------------------------- | ------------------------------------------------------------------------- |
| **Color**         | Brand and semantic colors | `--orange`, `--blue`, `--green`, `--cream`, `--charcoal`                  |
| **Spacing**       | Margins, padding, gaps    | `--gap` (base unit)                                                       |
| **Border Radius** | Corner rounding           | `--radius-sm`, `--radius`, `--radius-lg`, `--radius-xl`, `--radius-panel` |
| **Typography**    | Font families             | `--font-body`, `--font-mono`                                              |
| **Animation**     | Easing & spring curves    | `--ease`, `--spring`                                                      |

---

## Color Palette

### Primary Colors (Corbits Brand)

Extracted from workbench.html (`--orange`, `--blue`, `--green`, `--cream`, `--charcoal`):

| Color             | Hex       | Usage                               | Variable          |
| ----------------- | --------- | ----------------------------------- | ----------------- |
| **Orange**        | `#e98428` | Primary action, buttons, highlights | `--orange`        |
| **Orange Deep**   | `#bf6b20` | Hover state for primary actions     | `--orange-deep`   |
| **Orange Soft**   | `#f2b277` | Disabled or secondary orange state  | `--orange-soft`   |
| **Blue**          | `#607c9a` | Secondary actions, neutral elements | `--blue`          |
| **Blue Deep**     | `#2d455c` | Hover state for blue elements       | `--blue-deep`     |
| **Blue Soft**     | `#c5d2de` | Light backgrounds, disabled state   | `--blue-soft`     |
| **Green**         | `#7b9974` | Success, completion, done states    | `--green`         |
| **Green Deep**    | `#425a3d` | Hover state for green elements      | `--green-deep`    |
| **Green Soft**    | `#c1d1be` | Light success backgrounds           | `--green-soft`    |
| **Cream**         | `#f7ead5` | Page background (light), highlights | `--cream`         |
| **Cream Deep**    | `#e4d5bc` | Secondary cream backgrounds         | `--cream-deep`    |
| **Charcoal**      | `#2b2627` | Text, dark backgrounds              | `--charcoal`      |
| **Charcoal 2**    | `#5c5555` | Secondary text                      | `--charcoal-2`    |
| **Charcoal Deep** | `#1f1a1b` | Darkest elements                    | `--charcoal-deep` |

### Theme-Aware Colors

The design system supports **light and dark themes**. Use semantic color variables (e.g., `--text`, `--surface`) which automatically adjust based on `html[data-theme]`:

| Semantic Variable | Light Theme              | Dark Theme                  | Usage                         |
| ----------------- | ------------------------ | --------------------------- | ----------------------------- |
| `--page`          | `#efdcbe`                | `#151112`                   | Page background               |
| `--bg`            | `#f7ead5`                | `#221d1e`                   | Main background               |
| `--surface`       | `#ffffff`                | `#2b2627`                   | Card/panel backgrounds        |
| `--surface-2`     | `#f2f4f5`                | `#322c2d`                   | Secondary surface             |
| `--text`          | `#2b2627`                | `#f7ead5`                   | Primary text                  |
| `--text-2`        | `#5c5555`                | `#c3b6a3`                   | Secondary text                |
| `--text-3`        | `#9a8e80`                | `#8a8079`                   | Tertiary text (hints, labels) |
| `--border`        | `rgba(43, 38, 39, 0.1)`  | `rgba(247, 234, 213, 0.1)`  | Light borders                 |
| `--border-strong` | `rgba(43, 38, 39, 0.22)` | `rgba(247, 234, 213, 0.22)` | Emphasized borders            |
| `--row-hover`     | `rgba(43, 38, 39, 0.05)` | `rgba(247, 234, 213, 0.05)` | Hover state backgrounds       |

**Implementation:** These are defined in `packages/ui/src/styles.css` under `@theme`. All components using Tailwind utility classes inherit them automatically.

---

## Typography

| Element       | Font Family                              | Variable      | Usage                                   |
| ------------- | ---------------------------------------- | ------------- | --------------------------------------- |
| **Body**      | Red Hat Display, fallback to system sans | `--font-body` | All UI text, headers, labels            |
| **Monospace** | Space Mono, fallback to system mono      | `--font-mono` | Code, IDs, technical values, timestamps |

### Font Sizing (via Tailwind classes)

Use Tailwind's standard sizing: `text-sm` (12px), `text-base` (14px), `text-lg` (16px), `text-xl` (20px), `text-2xl` (24px), etc.

### Font Weight

- **Regular (400):** Body text, descriptions
- **Medium (500):** Navigation, section labels
- **Semi-bold (600):** Highlight text, buttons
- **Bold (700):** Headings, emphasis
- **Extra-bold (800):** Primary headings, large titles

---

## Spacing & Layout

### Base Unit

All spacing uses multiples of `--gap: 14px`:

| Name    | Value  | Usage                               |
| ------- | ------ | ----------------------------------- |
| `--gap` | `14px` | Base unit for padding, margin, gaps |

### Standard Spacing Scale

Use Tailwind's spacing utilities (derived from base unit):

| Size | Pixels | Tailwind Class      | Usage                                 |
| ---- | ------ | ------------------- | ------------------------------------- |
| `xs` | 4px    | `p-1`               | Tight padding (icons, small elements) |
| `sm` | 8px    | `p-2`               | Small padding                         |
| `md` | 14px   | `p-3.5` / `gap-3.5` | Standard padding, gaps (base unit)    |
| `lg` | 20px   | `p-5`               | Large padding                         |
| `xl` | 28px   | `p-7`               | Extra large padding                   |

**Container widths:**

- Max content width: `1180px` (set on layout shells)
- Sidebar width (default): `340px` (resizable, min `248px`, max `620px`)

---

## Border Radius

| Name             | Value  | Usage                            | Variable         |
| ---------------- | ------ | -------------------------------- | ---------------- |
| `--radius-sm`    | `8px`  | Small buttons, inputs            | `--radius-sm`    |
| `--radius`       | `12px` | Standard borders (cards, modals) | `--radius`       |
| `--radius-lg`    | `18px` | Larger cards, prominent elements | `--radius-lg`    |
| `--radius-xl`    | `24px` | Modal containers                 | `--radius-xl`    |
| `--radius-panel` | `28px` | Large panels, sidebars           | `--radius-panel` |

**Implementation:** Defined in `packages/ui/src/styles.css` via `@theme`. Use the corresponding Tailwind utility classes (`rounded-sm`, `rounded-lg`, etc.) directly in components.

---

## Responsive Design

### Mobile-First Approach

All UI is built mobile-first, then enhanced for larger screens. This means:

1. Base styles work on phones (320px+)
2. Use Tailwind's responsive prefixes to adjust layout at breakpoints
3. Test on real mobile devices, not just browser DevTools

### Breakpoints

Tailwind's default breakpoints (already configured):

| Name        | Width       | Usage                 | Prefix                               |
| ----------- | ----------- | --------------------- | ------------------------------------ |
| Mobile      | 320px–639px | Phones, small screens | (default)                            |
| Small       | 640px+      | `sm:`                 | Tablets in portrait                  |
| Medium      | 768px+      | `md:`                 | Tablets in landscape, small desktops |
| Large       | 1024px+     | `lg:`                 | Desktops                             |
| Extra-large | 1280px+     | `xl:`                 | Large monitors                       |

### Responsive Guidelines

**All interactive elements must be touchable on mobile:**

- Minimum tap target size: `44px × 44px` (iOS standard)
- Buttons, links: never smaller than `44px × 44px`
- Spacing between tappable elements: minimum `8px`

**Layout patterns:**

| Mobile          | Tablet               | Desktop              | Pattern                                         |
| --------------- | -------------------- | -------------------- | ----------------------------------------------- |
| Single column   | 2 columns            | 3 columns            | Use `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` |
| Stacked buttons | Side-by-side buttons | Side-by-side buttons | Use `flex-col sm:flex-row`                      |
| Full width      | Padded width         | Max-width container  | Use `w-full md:max-w-4xl md:mx-auto`            |

**Hidden/visible utilities:**

- Hide on mobile: `hidden sm:block`
- Show only on mobile: `sm:hidden`
- Show only on desktop: `hidden lg:block`

### Current Responsive Issues

**Critical issues to fix:**

1. **Buttons out of view**
   - Overflow on small screens (likely due to fixed widths, `nowrap`)
   - Solution: Use responsive width classes (`w-full md:w-auto`)
   - Affected areas: Call input form, modal buttons, action panels

2. **Layout breaks at mobile breakpoints**
   - Two-column layout (rail + gallery) doesn't collapse to single-column on mobile
   - Solution: Apply `md:grid-cols-1 lg:grid-cols-2` to the main shell
   - Currently: Always tries to show both columns

3. **Typography overflow**
   - Long titles don't wrap or truncate on mobile
   - Solution: Add `truncate` or `line-clamp-2` classes to headings

4. **Modal/dialog sizing**
   - Modals use fixed width `880px`, become too large on mobile
   - Solution: Use responsive max-width: `w-full max-w-2xl md:max-w-4xl`

5. **Sidebar resizer not mobile-friendly**
   - Drag handle invisible on phones; sidebar should be hidden/visible toggle instead
   - Solution: Media query to hide handle, add hamburger toggle on mobile

---

## Component System

shadcn/ui is **not installed** and is not planned. The workbench uses `@workbench/ui` — a custom component package at `packages/ui/` built directly on Tailwind v4 utility classes and the CSS token system above.

### Where components live

| Layer      | Location                   | Contents                                                 |
| ---------- | -------------------------- | -------------------------------------------------------- |
| Foundation | `packages/ui/src/`         | Primitives: Button, Input, Badge, tokens, `cn()` utility |
| Domain     | `apps/web/src/components/` | Product-specific components built on the foundation      |

### Rules

- Use `@workbench/ui` primitives for buttons, inputs, and layout shells.
- Build domain components (agent panels, workflow views, etc.) in `apps/web/src/components/`.
- All components inherit Corbits tokens via Tailwind utility classes — no inline styles, no hardcoded colors.
- Dark/light theme works automatically via `html[data-theme]` — no per-component theme logic needed.

---

---

## Decision Log

### Why CSS Custom Properties?

CSS variables allow:

1. **Dynamic theme switching** (light ↔ dark) without reloading
2. **Easy maintenance** — change colors in one place, apply everywhere
3. **Performance** — no runtime JS needed for theme swapping
4. **Component portability** — components work with any theme layer built on top

### Why Mobile-First?

- Smaller viewport = simpler design; easier to progressively enhance
- Mobile is primary for many users; ensures they get a good experience
- CSS media queries are smaller than doing mobile as an afterthought

### Why @workbench/ui Over shadcn?

shadcn/ui was originally considered but not adopted. `@workbench/ui` gives full control over the component contract, avoids the shadcn init / copy-paste model, and keeps the token system tightly integrated with Tailwind v4's `@theme` approach. Domain components stay in `apps/web/src/components/` and use the foundation primitives directly.

---

## References

- **`packages/ui/src/styles.css`** — authoritative source for all design tokens
- **Tailwind CSS v4 Docs:** https://tailwindcss.com
- **Web.dev Mobile Design:** https://web.dev/responsive-web-design-basics
