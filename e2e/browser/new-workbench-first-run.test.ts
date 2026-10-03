// CL-9844: a fresh bench lands on /new as a first-workbench onboarding step
// with no roles picker gating the composer.
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

describeBrowser("new workbench first run", () => {
  const app = bootBrowserApp();

  test("zero workbenches get onboarding copy and an ungated composer", async () => {
    const { page } = await app().newPage();
    try {
      await page.goto(app().origin, { waitUntil: "networkidle0" });
      await page.waitForSelector(".auth-switch", { timeout: 30_000 });
      await page.click(".auth-switch");
      await page.type(
        "input:not([type=password]):not([type=hidden])",
        `firstrun-${String(Date.now())}@example.com`,
      );
      await page.type("input[type=password]", "correct-horse-battery-staple");
      await page.click("button[type=submit]");

      await page.waitForFunction("location.pathname === '/onboarding'", { timeout: 30_000 });
      await page.waitForSelector("button::-p-text(Skip for now)", { timeout: 30_000 });
      // A synthetic click: the step's buttons animate and pointer clicks miss.
      await page.evaluate(
        "Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('Skip for now')).click()",
      );
      await page.waitForFunction("location.pathname === '/new'", { timeout: 30_000 });

      // First-run framing, not the generic empty-shell prompt.
      await waitForText(page, "Create your first workbench");

      // No roles picker: creating a workbench deploys its agent already.
      const body = (await page.evaluate("document.body.innerText")) as string;
      expect(body.includes("Roles for this workbench")).toBe(false);

      // The composer is usable without waiting on a roles read.
      await page.waitForSelector("textarea:not([disabled])", { timeout: STEP_TIMEOUT });
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(`new-workbench-first-run failed at ${page.url()}:\n${String(body)}\n`);
      throw cause;
    }
    await page.close();
  }, 120_000);
});
