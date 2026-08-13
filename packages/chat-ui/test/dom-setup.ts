// Registers a happy-dom global DOM before DOM-dependent suites run.
//
// Every other suite in this package renders with `renderToStaticMarkup`,
// which never runs an effect. `chat-workspace.test.tsx` mounts
// `ChatWorkspace` to prove real effect-driven sequencing (the
// channels-then-settings load order), and `use-typing-indicator.test.tsx`
// drives real timers off real effects — both need a registered DOM the
// same way `@corbits/command-palette`'s suites do.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
