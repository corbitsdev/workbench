// The 0-to-1 gate against scripted inference, one flow: signup, provider, a
// bench from /new, a worker reply that names the worker, a follow-up reply,
// an artifact the worker saves, a routine "Run now" brief, and a worker
// rename that survives reload. The Linear-connect step is not here (CL-9513).
import { expect, test } from "bun:test";
import { bootAimock, MOCK_REPLY, type Fixture } from "../lib/aimock";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const FOLLOW_UP = "FOLLOW-UP-QUESTION";
const FOLLOW_UP_REPLY = "Second reply from the worker.";
const SAVE_ARTIFACT = "SAVE-ARTIFACT";
const ARTIFACT_TITLE = "Gate artifact";
const ARTIFACT_DONE = "Saved the gate artifact.";
const BRIEF = "Brief: nothing shipped this week.";

// The worker-reply test's worker names itself. Registered after the scripted
// turns so exact matches win, ahead of bootAimock's default MOCK_REPLY
// fallback — which the gate's own first reply still falls through to.
const ADA_REPLY: Fixture = {
  match: { predicate: () => true },
  response: { content: `${MOCK_REPLY}\n\nName: Ada` },
};

const FIXTURES: Fixture[] = [
  { match: { userMessage: FOLLOW_UP }, response: { content: FOLLOW_UP_REPLY } },
  {
    match: { userMessage: SAVE_ARTIFACT, hasToolResult: false },
    response: {
      toolCalls: [
        {
          name: "artifact_create",
          arguments: JSON.stringify({
            title: ARTIFACT_TITLE,
            kind: "document",
            content: "Scripted artifact body.",
          }),
        },
      ],
    },
  },
  {
    match: { userMessage: SAVE_ARTIFACT, hasToolResult: true },
    response: { content: ARTIFACT_DONE },
  },
  { match: { userMessage: "Run now" }, response: { content: BRIEF } },
];

// Runs in the page so the signed-in session cookie applies.
const TRIGGER_SCRIPT = `(async () => {
  const bench = decodeURIComponent(location.pathname.split("/")[2]);
  const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
  const benchTenant = await json(await fetch("/api/tenants/" + bench));
  const tenants = [bench, benchTenant.body?.parentId].filter(Boolean);
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const tenantId of tenants) {
      const listed = await json(await fetch("/api/tenants/" + tenantId + "/workflows/deployments"));
      const deployment = (Array.isArray(listed.body) ? listed.body : []).find((d) => d.status === "deployed");
      if (!deployment) continue;
      const trigger = await json(await fetch("/api/tenants/" + tenantId + "/workflows/" + encodeURIComponent(deployment.id) + "/mail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Run now" }),
      }));
      return { tenantId, trigger };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { tenants };
})()`;

const ARTIFACTS_SCRIPT = `(async () => {
  const bench = decodeURIComponent(location.pathname.split("/")[2]);
  const r = await fetch("/api/tenants/" + bench + "/artifacts");
  return { status: r.status, body: await r.json().catch(() => null) };
})()`;

async function send(page: import("puppeteer-core").Page, text: string): Promise<void> {
  await page.waitForSelector("textarea:not([disabled])", { timeout: STEP_TIMEOUT });
  await page.type("textarea", text);
  await page.keyboard.press("Enter");
}

describeBrowser("0-to-1 gate", () => {
  const aimock = bootAimock([...FIXTURES, ADA_REPLY]);
  const app = bootBrowserApp();

  test("signup to reply, follow-up, artifact, and routine brief", async () => {
    const { page, errors } = await app().newPage();
    try {
      await page.goto(app().origin, { waitUntil: "networkidle0" });
      await clickText(page, "button", "Create an account");
      await waitForText(page, "Create your account");
      await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
      await page.type("input[type=password]", "correct-horse-battery-staple");
      await page.click("button[type=submit]");

      // Only the Custom option takes a base URL.
      await waitForText(page, "Choose your AI model");
      await clickText(page, "label", "Custom");
      await page.waitForSelector("input[type=password]");
      await page.type("form input:not([type=radio]):not([type=password])", `${aimock().url}/v1`);
      await page.type("input[type=password]", "mock");
      const fields = await page.$$("form input:not([type=radio]):not([type=password])");
      await fields[1]?.type("mock-model");
      // Custom takes base URL, key, and model: three non-radio inputs.
      const inputs = await page.$$("form input:not([type=radio])");
      expect(inputs.length).toBeGreaterThanOrEqual(3);
      await clickText(page, "button", "Connect");

      await page.waitForSelector("textarea", { timeout: STEP_TIMEOUT });
      await page.type("textarea", "Say hello");
      await page.click("button[aria-label='Start this workbench']");
      await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
      const benchUrl = page.url();
      await waitForText(page, MOCK_REPLY);

      // The worker named itself: pill, sidebar and message header show it,
      // and the marker line is never rendered.
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
      await page.goto(benchUrl, { waitUntil: "networkidle0" });

      await send(page, FOLLOW_UP);
      await waitForText(page, FOLLOW_UP_REPLY);

      await send(page, SAVE_ARTIFACT);
      await waitForText(page, ARTIFACT_DONE);
      const listing = (await page.evaluate(ARTIFACTS_SCRIPT)) as { status: number; body: unknown };
      expect(listing.status).toBe(200);
      expect(JSON.stringify(listing.body)).toContain(ARTIFACT_TITLE);
      await page.click("button[aria-controls='bench-drawer']");
      await clickText(page, "[role=tab]", "Artifacts");
      await waitForText(page, ARTIFACT_TITLE);

      // Gap: no routine workflow is deployed in the harness, so "Run now" mails
      // Worker's own deployment; the brief is her scripted reply, not a
      // routine-authored brief with its own artifact.
      const run = (await page.evaluate(TRIGGER_SCRIPT)) as {
        trigger?: { status: number };
      };
      expect(run.trigger?.status).toBe(202);
      await waitForText(page, BRIEF);

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
        `zero-to-one failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\njournal: ${JSON.stringify(aimock().journal()).slice(-3000)}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 300_000);
});
