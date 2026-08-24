# @corbits/chat-ui

The chat surface's UI: the active-conversation workspace, message timeline,
composer, and the pure helpers behind workbench settings, mentions, slash
commands, and typing indicators. Presentational primitives (buttons,
dialogs, menus) come from `@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui)); this
package holds the workbench-specific composition on top of them, plus the
HTTP client for the chat API.

Today's shape is single-column: `ChatWorkspace` renders the active
conversation only — the workbench list lives in the host shell's own
contextual panel, not in a package-owned sidebar (`sidebar.tsx` now holds
only the row-menu helpers the shell's panel calls into).

## Key modules

- `chat-workspace.tsx` — resolves the signed-in account's workbenches and
  deployed agents, wires the timeline and composer for the selected workbench
- `timeline.tsx` / `composer.tsx` — the message list and the send box,
  including attachment validation and mention/slash-command autocomplete
- `workbench-settings/` — the per-workbench settings surface (`WorkbenchSettingsSurface`),
  including context-window controls
- `blocks/` — typed rendering for approval, poll, and form message parts
- `api.ts` — the chat HTTP client: workbenches, messages, threads, reactions,
  pins, runs, and invitable agent definitions
- `shared-workbenches.ts` / `direct-workbench.ts` —
  pure lookup helpers
- `use-workbench-stream.ts` — the live-update hook for an open workbench

## Running tests

```
cd packages/chat-ui && bun test
```

Several suites mount into a real DOM (see `test/dom-setup.ts`); running from
the package directory picks up `bunfig.toml`'s preload.
