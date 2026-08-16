// A DOM for the tests that need one — see
// `@corbits/settings-ui`'s own `test/dom-environment.ts`, which this
// copies exactly. Registered through `bunfig.toml`'s preload so it is in
// place before any test module imports React.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://workbench.test/" });

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
