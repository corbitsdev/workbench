// Shared browser steps for e2e: sign up, connect a placeholder provider, and
// create a first workbench.
import { expect } from "bun:test";
import type { Page } from "puppeteer-core";

export const STEP_TIMEOUT = 60_000;
export const FIRST_WORKBENCH = "Summarize what shipped this week";

// Page scripts are strings: this tsconfig has no DOM lib.
export async function waitForText(page: Page, label: string): Promise<void> {
  await page.waitForFunction(`document.body.innerText.includes(${JSON.stringify(label)})`, {
    timeout: STEP_TIMEOUT,
  });
}

export async function clickText(page: Page, selector: string, label: string): Promise<void> {
  const script = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((e) => e.textContent.includes(${JSON.stringify(label)}))`;
  await page.waitForFunction(script, { timeout: STEP_TIMEOUT });
  await page.evaluate(`(${script}).click()`);
}

export async function runFirstRunFlow(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "networkidle0" });

  await clickText(page, "button", "Create an account");
  await waitForText(page, "Create your account");
  await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
  await page.type("input[type=password]", "correct-horse-battery-staple");
  await page.click("button[type=submit]");

  // Provider connect is the only onboarding step; a placeholder key is
  // enough because connecting stores a credential without calling the provider.
  await waitForText(page, "Choose your AI model");
  await clickText(page, "label", "Anthropic");
  await page.waitForSelector("input[type=password]");
  await page.type("input[type=password]", "sk-ant-placeholder");
  await clickText(page, "button", "Connect");

  // Connecting hands off to the new-workbench prompt (a workspace with no
  // workbenches); the first bench's worker is the first worker.
  // The composer stays disabled until workspace roles have loaded (CL-9780).
  await page.waitForFunction(
    `(() => {
      const input = document.querySelector("textarea");
      return input instanceof HTMLTextAreaElement && !input.disabled;
    })()`,
    { timeout: STEP_TIMEOUT },
  );
  await page.type("textarea", FIRST_WORKBENCH);
  await page.waitForFunction(
    `(() => {
      const send = document.querySelector("button[aria-label='Start this workbench']");
      return send instanceof HTMLButtonElement && !send.disabled;
    })()`,
    { timeout: STEP_TIMEOUT },
  );
  await page.click("button[aria-label='Start this workbench']");

  // Creating the workbench navigates to its own page, which shows the prompt.
  await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
  await waitForText(page, FIRST_WORKBENCH);
  expect(new URL(page.url()).pathname).toStartWith("/w/");
}
