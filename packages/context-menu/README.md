# @corbits/context-menu

The deployment-agnostic half of the global right-click context-menu
system: resolving a DOM event to a typed target, deciding whether an open
modal should suppress the menu, the open/position state machine, the
single document-level listener that drives it, and returning focus to the
right-clicked row on close. Presentation renders through `@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui))'s `Menu`
family via `ContextMenuView`. What counts as a target and which items it
offers is product-specific and stays with the host app.

## Key modules

- `target-resolver.ts` — `resolveTarget`, mapping a DOM event to a typed
  `TargetDefinition`
- `dialog-guard.ts` — `isBlockingOverlayOpen`/`isInsideInteractiveInput`,
  the checks that suppress the menu under an open modal or inside an input
- `use-context-menu-state.ts` — the open/position state hook
- `use-document-context-menu-trigger.ts` — the single document listener a
  host mounts once
- `focus-restore.ts` — `findFocusable`/`restoreFocus`, returning focus to
  the triggering row on close
- `menu.ts` — `contextMenuItem`/`contextMenuSeparator`, the pure menu-shape
  builders a host composes into a `ContextMenu`
- `context-menu-view.tsx` — the react-ui-backed presentation, `ContextMenuView`

## Running tests

```
cd packages/context-menu && bun test
```

Some suites mount into a real DOM (see `test/dom-setup.ts`); running from
the package directory picks up `bunfig.toml`'s preload.
