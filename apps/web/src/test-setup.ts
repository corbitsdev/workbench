import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerFramerMotionMock } from "@workbench/test-utils/framer-motion";

GlobalRegistrator.register();

(
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM.setURL("http://localhost/");

export { registerFramerMotionMock };

registerFramerMotionMock();
