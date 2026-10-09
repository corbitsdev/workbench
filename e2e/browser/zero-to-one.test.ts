// The 0-to-1 gate against scripted inference, one flow: signup, provider, a
// bench from /new, a worker reply that names the worker, a follow-up reply,
// an artifact the worker saves, a routine "Run now" brief, and a worker
// rename that survives reload. The Linear-connect step is not here (CL-9513).
import { expect, test } from "bun:test";
import { bootAimock, MOCK_REPLY, type Fixture } from "../lib/aimock";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, startWorkbench, waitForText } from "../lib/first-run";

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
  response: {
    content: `${MOCK_REPLY}\n\n${"This longer reply keeps the conversation scrolling while its prose stays readable.\n\n".repeat(16)}Name: Ada`,
  },
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

      await startWorkbench(page, "Say hello");
      await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
      const benchUrl = page.url();
      await page.waitForSelector(".chat-thread-working", { timeout: STEP_TIMEOUT });
      await waitForText(page, MOCK_REPLY);
      await page.waitForFunction(`!document.querySelector(".chat-thread-working")`, {
        timeout: STEP_TIMEOUT,
      });
      // The worker reply proves the scripted inference provider was dialed,
      // not just the UI shell loading.
      expect(aimock().journal().length).toBeGreaterThan(0);

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

      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      const waitForLayout = () =>
        page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      for (const { width, reservedSpace } of [
        { width: 2048, reservedSpace: 0 },
        { width: 1800, reservedSpace: 0 },
        { width: 1200, reservedSpace: 0 },
        { width: 900, reservedSpace: 0 },
        { width: 861, reservedSpace: 0 },
        { width: 860, reservedSpace: 0 },
        { width: 800, reservedSpace: 0 },
        { width: 390, reservedSpace: 0 },
        { width: 1800, reservedSpace: 16 },
        { width: 900, reservedSpace: 16 },
        { width: 1800, reservedSpace: 20 },
        { width: 900, reservedSpace: 20 },
      ]) {
        await page.setViewport({ width, height: 900 });
        // Simulate reserved scrollbar space on hosts with overlay scrollbars.
        await page.$eval(
          ".workbench-main-scroll",
          (element, space) => {
            if (!(element instanceof HTMLElement)) throw new Error("Missing scroll pane");
            element.style.borderInlineEnd = `${space}px solid transparent`;
          },
          reservedSpace,
        );
        for (const drawerOpen of [false, true]) {
          if (drawerOpen) {
            await page.click(".bench-pill");
            await waitForLayout();
          }
          const layout = await page.evaluate(() => {
            const element = (selector: string) => {
              const found = document.querySelector(selector);
              if (found === null) throw new Error(`Missing layout element: ${selector}`);
              return found;
            };
            const bounds = (selector: string) => {
              const { left, right, width } = element(selector).getBoundingClientRect();
              return { left, right, width };
            };
            const scroll = element(".workbench-main-scroll");
            const prose = element(
              '.timeline-inner .chat-thread-message:not([data-author="me"]) .chat-thread-body',
            );
            return {
              main: bounds(".workbench-main"),
              timeline: bounds(".timeline-inner"),
              divider: bounds(".timeline-inner .chat-day"),
              composer: bounds(".workbench-main-composer .chat-composer-box"),
              worker: bounds(".timeline-inner .chat-thread-avatar"),
              user: bounds(".timeline-inner .chat-thread-own-bubble"),
              proseWidth: prose.getBoundingClientRect().width,
              proseLimit: Number.parseFloat(getComputedStyle(prose).maxWidth),
              reservedWidth: scroll.getBoundingClientRect().width - scroll.clientWidth,
              scrolls: scroll.scrollHeight > scroll.clientHeight,
              overflows: scroll.scrollWidth > scroll.clientWidth,
              pageOverflows: document.documentElement.scrollWidth > innerWidth,
            };
          });
          if (drawerOpen) {
            const drawer = await page.evaluate(() => {
              const cell = document.querySelector(".drawer-cell")?.getBoundingClientRect();
              const element = document.querySelector(".drawer");
              if (cell === undefined || element === null) throw new Error("Missing drawer");
              const card = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                left: card.left - cell.left,
                right: cell.right - card.right,
                shadow: style.boxShadow,
                radius: Number.parseFloat(style.borderRadius),
                divider: Number.parseFloat(style.borderLeftWidth),
              };
            });
            expect(Math.abs(drawer.left), `${width}px drawer left edge`).toBeLessThanOrEqual(1);
            expect(Math.abs(drawer.right), `${width}px drawer right edge`).toBeLessThanOrEqual(1);
            if (width > 860) {
              expect(drawer.shadow, `${width}px nested drawer surface`).toBe("none");
              expect(drawer.radius, `${width}px flat drawer edge`).toBe(0);
              expect(drawer.divider, `${width}px visible drawer divider`).toBe(1);
            }
          }
          const context = `${width}px, drawer ${drawerOpen ? "open" : "closed"}, reserved space ${reservedSpace}px`;
          for (const box of [layout.timeline, layout.divider]) {
            expect(Math.abs(box.left - layout.composer.left), context).toBeLessThanOrEqual(1);
            const offset = drawerOpen ? 16 - layout.reservedWidth : 0;
            expect(
              Math.abs(box.right - layout.composer.right - offset),
              context,
            ).toBeLessThanOrEqual(1);
          }
          const leftGutter = layout.composer.left - layout.main.left;
          const rightGutter = layout.main.right - layout.composer.right;
          expect(
            Math.abs(drawerOpen ? rightGutter - 16 : leftGutter - rightGutter),
            context,
          ).toBeLessThanOrEqual(1);
          expect(leftGutter, context).toBeGreaterThanOrEqual(32);
          expect(layout.composer.width, context).toBeLessThanOrEqual(1200);
          expect(Math.abs(layout.worker.left - layout.composer.left), context).toBeLessThanOrEqual(
            1,
          );
          expect(
            Math.abs(
              layout.composer.right - layout.user.right - (drawerOpen ? layout.reservedWidth : 16),
            ),
            context,
          ).toBeLessThanOrEqual(1);
          expect(layout.proseWidth, context).toBeLessThanOrEqual(layout.proseLimit + 1);
          expect(layout.scrolls, context).toBe(true);
          expect(layout.overflows, context).toBe(false);
          expect(layout.pageOverflows, context).toBe(false);
          if (drawerOpen) {
            await page.click('#bench-drawer button[aria-label="Close drawer"]');
            await waitForLayout();
          }
        }
        if (width >= 900) {
          await page.click('.timeline-inner .chat-thread-message[data-author="me"] button');
          await page.waitForSelector(".workbench-subthread");
          await waitForLayout();
          const replyLayout = await page.evaluate(() => {
            const bounds = (selector: string) => {
              const element = document.querySelector(selector);
              if (element === null) throw new Error(`Missing layout element: ${selector}`);
              return element.getBoundingClientRect();
            };
            const composer = bounds(".workbench-main-composer .chat-composer-box");
            const scroll = document.querySelector(".workbench-main-scroll");
            if (scroll === null) throw new Error("Missing scroll pane");
            return {
              gap: bounds(".workbench-subthread").left - composer.right,
              dividerGap: composer.right - bounds(".timeline-inner .chat-day").right,
              userInset: composer.right - bounds(".timeline-inner .chat-thread-own-bubble").right,
              reservedWidth: scroll.getBoundingClientRect().width - scroll.clientWidth,
              timelineLeft: bounds(".timeline-inner").left - composer.left,
              leftGutter: composer.left - bounds(".workbench-main").left,
              width: composer.width,
              overflows: scroll.scrollWidth > scroll.clientWidth,
              pageOverflows: document.documentElement.scrollWidth > innerWidth,
            };
          });
          const context = `${width}px, replies open, reserved space ${reservedSpace}px`;
          expect(Math.abs(replyLayout.gap - 16), context).toBeLessThanOrEqual(1);
          expect(Math.abs(replyLayout.timelineLeft), context).toBeLessThanOrEqual(1);
          expect(
            Math.abs(replyLayout.dividerGap + 16 - replyLayout.reservedWidth),
            context,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(replyLayout.userInset - replyLayout.reservedWidth),
            context,
          ).toBeLessThanOrEqual(1);
          expect(replyLayout.leftGutter, context).toBeGreaterThanOrEqual(32);
          expect(replyLayout.width, context).toBeLessThanOrEqual(1200);
          expect(replyLayout.overflows, context).toBe(false);
          expect(replyLayout.pageOverflows, context).toBe(false);
          await page.click(".bench-pill");
          await waitForLayout();
          const drawerWithReplies = await page.evaluate(() => {
            const cell = document.querySelector(".drawer-cell")?.getBoundingClientRect();
            const card = document.querySelector(".drawer")?.getBoundingClientRect();
            const body = document.querySelector(".drawer-body");
            if (cell === undefined || card === undefined || body === null) {
              throw new Error("Missing drawer");
            }
            return {
              left: card.left - cell.left,
              right: cell.right - card.right,
              overflows: body.scrollWidth > body.clientWidth,
            };
          });
          expect(Math.abs(drawerWithReplies.left), context).toBeLessThanOrEqual(1);
          expect(Math.abs(drawerWithReplies.right), context).toBeLessThanOrEqual(1);
          expect(drawerWithReplies.overflows, context).toBe(false);
          await page.click('#bench-drawer button[aria-label="Close drawer"]');
          await page.click(".workbench-subthread-head button");
          await page.waitForSelector(".workbench-subthread", { hidden: true });
          await waitForLayout();
          const restoredCenter = await page.evaluate(() => {
            const main = document.querySelector(".workbench-main")?.getBoundingClientRect();
            const composer = document
              .querySelector(".workbench-main-composer .chat-composer-box")
              ?.getBoundingClientRect();
            if (main === undefined || composer === undefined) throw new Error("Missing layout");
            return composer.left - main.left - (main.right - composer.right);
          });
          expect(Math.abs(restoredCenter), context).toBeLessThanOrEqual(1);
        }
      }
      await page.setViewport({ width: 1400, height: 900 });

      await page.$eval(".workbench-main-scroll", (element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Missing scroll pane");
        element.style.removeProperty("border-inline-end");
      });
      await page.emulateMediaFeatures([]);
      await waitForLayout();

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
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});
