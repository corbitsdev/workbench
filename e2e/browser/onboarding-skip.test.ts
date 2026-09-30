// Skipping the provider step sticks: a reload lands in the shell, not back
// on /onboarding.
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";

const describeBrowser = browserGate(import.meta.path);

describeBrowser("onboarding skip", () => {
  const app = bootBrowserApp();

  test("a skipped provider step survives a reload", async () => {
    const { page } = await app().newPage();
    await page.goto(app().origin, { waitUntil: "networkidle0" });
    await page.waitForSelector(".auth-switch", { timeout: 30_000 });
    await page.click(".auth-switch");
    await page.type(
      "input:not([type=password]):not([type=hidden])",
      `skip-${String(Date.now())}@example.com`,
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

    await page.goto(app().origin, { waitUntil: "networkidle0" });
    // The provisioning probe runs after the session probe; give it time to
    // (wrongly) redirect before asserting.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(new URL(page.url()).pathname).not.toBe("/onboarding");
    // Still signed in: the sign-in form is gone.
    expect(await page.$("input[type=password]")).toBeNull();
    await page.close();
  }, 120_000);
});
