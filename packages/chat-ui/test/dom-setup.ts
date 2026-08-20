// Registers a happy-dom global DOM before DOM-dependent suites run.
//
// Every other suite in this package renders with `renderToStaticMarkup`,
// which never runs an effect. `chat-workspace.test.tsx` mounts
// `ChatWorkspace` to prove real effect-driven sequencing (the
// workbenches-then-settings load order), and `use-typing-indicator.test.tsx`
// drives real timers off real effects — both need a registered DOM the
// same way `@corbits/command-palette`'s suites do.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// React's `act(...)` warns unless the environment explicitly opts in — see
// `@corbits/command-palette`'s `test/dom-setup.ts` for the same flag. Every
// suite here that mounts a component (rather than calling
// `renderToStaticMarkup`) already wraps its state-driving calls in `act(...)`;
// this just tells React those wrappers are real.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
