import { GlobalRegistrator } from "@happy-dom/global-registrator";

// This package's other tests are pure functions of plain data and need no
// DOM. `useEntitySearch` is the exception — it debounces on a real timer and
// drives state off real effects, so it is exercised against a registered DOM
// rather than mocked piecemeal.
GlobalRegistrator.register();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
