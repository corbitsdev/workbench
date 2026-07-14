/**
 * DOM environment for @workbench/blocks component tests.
 * Loaded via `bun test --preload ./src/test-setup.ts` (see package.json `test` script).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
