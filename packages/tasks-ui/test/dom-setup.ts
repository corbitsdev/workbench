// Registers a happy-dom global DOM before DOM-dependent suites run —
// `task-composer-dialog.test.tsx` mounts `TaskComposerDialog`, and
// Radix's `Dialog.Portal` renders nothing under `renderToStaticMarkup`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
