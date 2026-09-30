// A fresh user signs up in a real browser, the client sets up its workspace
// over stock routes, connects a placeholder provider, and creates a first
// workbench that shows up in the sidebar. Asserts on visible UI only.
import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { bootBrowserApp, browserGate } from "../lib/browser";

const describeBrowser = browserGate(import.meta.path);
const STEP_TIMEOUT = 60_000;
const FIRST_WORKBENCH = "Summarize what shipped this week";

// Page scripts are strings: this tsconfig has no DOM lib.
async function waitForText(page: Page, label: string): Promise<void> {
  await page.waitForFunction(`document.body.innerText.includes(${JSON.stringify(label)})`, {
    timeout: STEP_TIMEOUT,
  });
}

async function clickText(page: Page, selector: string, label: string): Promise<void> {
  const script = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((e) => e.textContent.includes(${JSON.stringify(label)}))`;
  await page.waitForFunction(script, { timeout: STEP_TIMEOUT });
  await page.evaluate(`(${script}).click()`);
}

async function runFlow(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "networkidle0" });

  await clickText(page, "button", "Create an account");
  await waitForText(page, "Create your account");
  await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
  await page.type("input[type=password]", "correct-horse-battery-staple");
  await page.click("button[type=submit]");

  // Provider connect is the only onboarding step; a placeholder key is
  // enough because connecting stores a credential without calling the provider.
  await waitForText(page, "Connect a brain");
  await clickText(page, "label", "Anthropic");
  await page.waitForSelector("input[type=password]");
  await page.type("input[type=password]", "sk-ant-placeholder");
  await clickText(page, "button", "Connect");

  // Connecting installs Myra, then the ready screen hands off to the
  // new-workbench prompt (a workspace with no workbenches).
  await clickText(page, "button", "Start your first workbench");
  await page.waitForSelector("textarea", { timeout: STEP_TIMEOUT });
  await page.type("textarea", FIRST_WORKBENCH);
  await page.click("button[aria-label='Start this workbench']");

  // Creating the workbench navigates to its own page, which shows the prompt.
  await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
  await waitForText(page, FIRST_WORKBENCH);
  expect(new URL(page.url()).pathname).toStartWith("/w/");
}

// The test database outlives a run, so each run signs up a distinct alice.
describeBrowser("first run", () => {
  const app = bootBrowserApp();

  test("sign up, connect a provider, create a first workbench", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFlow(page, app().origin);
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
