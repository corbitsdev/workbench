import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerFramerMotionMock } from "./framer-motion-mock";

GlobalRegistrator.register();

registerFramerMotionMock();
