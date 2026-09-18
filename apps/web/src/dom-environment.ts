// A DOM for the tests that need one. Without it every UI test in this app is
// limited to `renderToStaticMarkup`, which never runs an effect — so hooks,
// listeners and focus behaviour could only be reasoned about, not asserted.
// Registered through `bunfig.toml`'s preload so it is in place before any
// test module imports React.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://workbench.test/" });

// React only lets `act()` flush effects when it is told it is in a test
// environment; without this every effect-driven assertion silently sees a
// half-rendered tree.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
