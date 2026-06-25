// Registers happy-dom globals for component tests. Imported directly by each
// test file (the package has no bunfig preload), so a DOM exists before
// @testing-library/react renders.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
