// A gated tool call parks the worker on an approval. The ask surfaces in the
// thread and on the bench pill without any navigation, either the thread card
// or the drawer's "Needs you" row answers it, and the worker's run resumes
// with the tool result.
import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { bootAimock, MOCK_REPLY, type Fixture } from "../lib/aimock";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const THREAD_ASK = "THREAD-SHELL";
// Longer than the drawer's argument preview, so the thread card is shown to
// carry the whole call rather than a truncated summary.
const THREAD_COMMAND = `echo ${"thread-approval-".repeat(10)}end`;
// The same turn parks a second time once the first call is answered.
const THREAD_SECOND_COMMAND = "echo second-thread-approval";
const THREAD_DONE = "Both thread-approved commands ran.";

const DRAWER_ASK = "DRAWER-SHELL";
const DRAWER_COMMAND = "echo drawer-approval";
const DRAWER_DONE = "The drawer-approved command ran.";

type ChatRequest = Parameters<NonNullable<Fixture["match"]["predicate"]>>[0];

// Tool results the model has seen since the latest message carrying `ask`.
function toolResultsSince(req: ChatRequest, ask: string): number | null {
  const asked = req.messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.includes(ask),
  );
  if (asked === -1) return null;
  return req.messages.slice(asked).filter((message) => message.role === "tool").length;
}

// One run_shell call per command, each parking the run on an approval, then
// `done` once every call has its result.
function shellFixtures(ask: string, commands: readonly string[], done: string): Fixture[] {
  return [
    ...commands.map((command, index) => ({
      match: { predicate: (req: ChatRequest) => toolResultsSince(req, ask) === index },
      response: { toolCalls: [{ name: "run_shell", arguments: JSON.stringify({ command }) }] },
    })),
    {
      match: { predicate: (req: ChatRequest) => toolResultsSince(req, ask) === commands.length },
      response: { content: done },
    },
  ];
}

async function startBenchWithWorker(page: Page, origin: string, aimockURL: string): Promise<void> {
  // Pages share one browser, so a previous test's session would skip signup.
  const cdp = await page.createCDPSession();
  await cdp.send("Network.clearBrowserCookies");
  await page.goto(origin, { waitUntil: "networkidle0" });
  await clickText(page, "button", "Create an account");
  await waitForText(page, "Create your account");
  await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
  await page.type("input[type=password]", "correct-horse-battery-staple");
  await page.click("button[type=submit]");

  // Only the Custom option takes a base URL.
  await waitForText(page, "Choose your AI model");
  await clickText(page, "label", "Custom");
  await page.waitForSelector("input[type=password]");
  await page.type("form input:not([type=radio]):not([type=password])", `${aimockURL}/v1`);
  await page.type("input[type=password]", "mock");
  const fields = await page.$$("form input:not([type=radio]):not([type=password])");
  await fields[1]?.type("mock-model");
  await clickText(page, "button", "Connect");

  // The composer renders disabled until the account's tenant resolves.
  await page.waitForSelector("textarea:not([disabled])", { timeout: STEP_TIMEOUT });
  await page.type("textarea", "Say hello");
  await page.click("button[aria-label='Start this workbench']");
  await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
  await waitForText(page, MOCK_REPLY);
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector("textarea:not([disabled])", { timeout: STEP_TIMEOUT });
  await page.type("textarea", text);
  await page.keyboard.press("Enter");
}

function threadIncludes(text: string): string {
  return `document.querySelector(".workbench-main")?.innerText.includes(${JSON.stringify(text)})`;
}

describeBrowser("approving a parked tool call", () => {
  const aimock = bootAimock([
    ...shellFixtures(THREAD_ASK, [THREAD_COMMAND, THREAD_SECOND_COMMAND], THREAD_DONE),
    ...shellFixtures(DRAWER_ASK, [DRAWER_COMMAND], DRAWER_DONE),
  ]);
  const app = bootBrowserApp();

  async function run(label: string, body: (page: Page) => Promise<void>): Promise<void> {
    const { page, errors } = await app().newPage();
    try {
      await startBenchWithWorker(page, app().origin, aimock().url);
      await body(page);
    } catch (cause) {
      const text = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `${label} failed at ${page.url()}:\n${String(text)}\nconsole: ${errors.join(" | ")}\njournal: ${JSON.stringify(aimock().journal()).slice(-3000)}\n`,
      );
      throw cause;
    }
    await page.close();
  }

  test("each ask in a turn lands in the thread and Allow once resumes the worker", async () => {
    await run("thread approval", async (page) => {
      await send(page, THREAD_ASK);

      await page.waitForFunction(threadIncludes(THREAD_COMMAND), { timeout: STEP_TIMEOUT });
      await page.waitForFunction(
        `document.querySelector(".bench-pill")?.innerText.includes("needs you")`,
        { timeout: STEP_TIMEOUT },
      );
      expect(await page.evaluate(threadIncludes(THREAD_DONE))).toBe(false);

      await clickText(page, ".workbench-main button", "Allow once");
      await page.waitForFunction(threadIncludes(THREAD_SECOND_COMMAND), { timeout: STEP_TIMEOUT });
      await clickText(page, ".workbench-main button", "Allow once");
      await page.waitForFunction(threadIncludes(THREAD_DONE), { timeout: STEP_TIMEOUT });
      await page.waitForFunction(`!${threadIncludes("Allow once")}`, { timeout: STEP_TIMEOUT });
    });
  }, 300_000);

  test("the drawer's Needs you row answers the same ask", async () => {
    await run("drawer approval", async (page) => {
      await send(page, DRAWER_ASK);

      await page.click("button[aria-controls='bench-drawer']");
      await clickText(page, "[role=tab]", "Information");
      await waitForText(page, DRAWER_COMMAND);

      await clickText(page, "#bench-drawer button", "Approve");
      await page.waitForFunction(threadIncludes(DRAWER_DONE), { timeout: STEP_TIMEOUT });
      await waitForText(page, "Nothing is waiting on you.");
    });
  }, 300_000);
});
