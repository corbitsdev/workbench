import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerFramerMotionMock } from "@workbench/test-utils/framer-motion";

// Vite injects __APP_VERSION__ at build time; provide it for the bun test runtime
// so components that read it don't hit a ReferenceError.
(globalThis as Record<string, unknown>).__APP_VERSION__ ??= "0.0.0-test";

GlobalRegistrator.register();

(
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM.setURL("http://localhost/");

export { registerFramerMotionMock };

registerFramerMotionMock();
