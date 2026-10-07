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
      response: {
        content: `${MOCK_REPLY}\n\n${"This longer reply keeps the conversation scrolling while its prose stays readable.\n\n".repeat(16)}Name: Ada`,
      },
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

      await page.waitForFunction(
        `(() => {
          const input = document.querySelector("textarea");
          return input instanceof HTMLTextAreaElement && !input.disabled;
        })()`,
        { timeout: STEP_TIMEOUT },
      );
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
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});
