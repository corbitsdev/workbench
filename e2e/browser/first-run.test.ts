// A fresh user signs up in a real browser, the client sets up its workspace
// over stock routes, connects a placeholder provider, and creates a first
// workbench that shows up in the sidebar. Asserts on visible UI only.
import { test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { runFirstRunFlow } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

// The test database outlives a run, so each run signs up a distinct alice.
describeBrowser("first run", () => {
  const app = bootBrowserApp();

  test("sign up, connect a provider, create a first workbench", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFirstRunFlow(page, app().origin);
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `first-run failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 240_000);
});
