import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Every other suite in this package renders with `renderToStaticMarkup`,
// which never runs an effect. `useTypingIndicator` drives real timers off
// real effects, so it needs an actual DOM to mount into rather than being
// reasoned about piecemeal.
GlobalRegistrator.register();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
