// Without a real DOM, tests are limited to `renderToStaticMarkup`, which
// never runs an effect. Registered via `bunfig.toml`'s preload.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://workbench.test/" });

// React only lets `act()` flush effects when it is told it is in a test
// environment; without this every effect-driven assertion silently sees a
// half-rendered tree.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
