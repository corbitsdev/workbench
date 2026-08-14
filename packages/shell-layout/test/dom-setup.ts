import { GlobalRegistrator } from "@happy-dom/global-registrator";

// `useShellLayoutMode` and `useScrollReset` are effect-driven — a real DOM
// is what lets `act()` flush those effects, so the other (pure) tests in
// this package need no preload but these do.
GlobalRegistrator.register();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
