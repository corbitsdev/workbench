// A fresh user connects an inference provider served by aimock, creates a
// bench from /new, and the worker's reply lands in the thread while the
// bench stops showing "working". The reply names the worker, which then shows
// everywhere; a rename in the bench drawer survives a reload.
import { expect, test } from "bun:test";
import { bootAimock, MOCK_REPLY } from "../lib/aimock";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

describeBrowser("worker reply", () => {
  const aimock = bootAimock([
    {
      match: { predicate: () => true },
      response: { content: `${MOCK_REPLY}\n\nName: Ada` },
    },
  ]);
  const app = bootBrowserApp();

  test("the worker's reply lands in the thread", async () => {
    const { page, errors } = await app().newPage();
    try {
      await page.goto(app().origin, { waitUntil: "networkidle0" });
      await clickText(page, "button", "Create an account");
      await waitForText(page, "Create your account");
      await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
      await page.type("input[type=password]", "correct-horse-battery-staple");
      await page.click("button[type=submit]");

      // The Anthropic option pins api.anthropic.com; only Custom takes a base URL.
      await waitForText(page, "Choose your AI model");
      await clickText(page, "label", "Custom");
      await page.waitForSelector("input[type=password]");
      const inputs = await page.$$("form input:not([type=radio])");
      expect(inputs.length).toBeGreaterThanOrEqual(3);
      await page.type("form input:not([type=radio]):not([type=password])", `${aimock().url}/v1`);
      await page.type("input[type=password]", "mock");
      const model = await page.$$("form input:not([type=radio]):not([type=password])");
      await model[1]?.type("mock-model");
      await clickText(page, "button", "Connect");

      await page.waitForSelector("textarea", { timeout: STEP_TIMEOUT });
      await page.type("textarea", "Say hello");
      await page.click("button[aria-label='Start this workbench']");
      await page.waitForFunction(`location.pathname.startsWith("/w/")`, {
        timeout: STEP_TIMEOUT,
      });

      await waitForText(page, MOCK_REPLY);
      await page.waitForFunction(`!document.body.innerText.toLowerCase().includes("working")`, {
        timeout: STEP_TIMEOUT,
      });
      expect(aimock().journal().length).toBeGreaterThan(0);

      // The worker named itself: pill, sidebar and message header show it,
      // and the marker line is never rendered.
      const benchUrl = page.url();
      await page.waitForFunction(
        `document.querySelector(".bench-pill")?.innerText.includes("Ada")`,
        {
          timeout: STEP_TIMEOUT,
        },
      );
      await page.waitForFunction(
        `document.querySelector("[aria-label='Workbenches and workers']")?.textContent.includes("Ada")`,
        { timeout: 20_000 },
      );
      expect(await page.evaluate("document.body.innerText.includes('Name: Ada')")).toBe(false);

      await page.goto(`${app().origin}/workers`, { waitUntil: "networkidle0" });
      await waitForText(page, "Ada");

      // Rename from the drawer; the new name persists across a reload.
      await page.goto(benchUrl, { waitUntil: "networkidle0" });
      await page.click(".bench-pill");
      await page.waitForSelector("input[aria-label='Worker name']");
      await page.evaluate(`document.querySelector("input[aria-label='Worker name']").select()`);
      await page.type("input[aria-label='Worker name']", "Bea");
      await clickText(page, "button", "Rename");
      await page.waitForFunction(
        `document.querySelector(".bench-pill")?.innerText.includes("Bea")`,
        {
          timeout: STEP_TIMEOUT,
        },
      );
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForFunction(
        `document.querySelector(".bench-pill")?.innerText.includes("Bea")`,
        {
          timeout: STEP_TIMEOUT,
        },
      );
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `reply failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\njournal: ${JSON.stringify(aimock().journal()).slice(0, 4000)}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 240_000);
});
