import { GlobalRegistrator } from "@happy-dom/global-registrator";

// This package's other tests render static markup and need no DOM.
// `chat-workspace.test.tsx` mounts `ChatWorkspace` to prove real effect-
// driven sequencing (the channels-then-settings load order), so it needs a
// registered DOM the same way `@corbits/command-palette`'s does.
GlobalRegistrator.register();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
