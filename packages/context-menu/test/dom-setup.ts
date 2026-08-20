import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Target resolution walks real `Element.closest()` chains and the trigger
// hook listens for real `contextmenu` DOM events, so these suites run
// against a registered DOM rather than mocked piecemeal.
GlobalRegistrator.register();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
