// CL-9785: the composer never scrolls horizontally (long unbroken tokens
// wrap) and sidebar rows go full-width with their radius intact.
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const VIEWPORT = { width: 1400, height: 900 };
// One unbroken token wider than any composer: without wrapping it would force
// a horizontal scrollbar.
const LONG_TOKEN = "a".repeat(400);

type RowBox = {
  active: string | null;
  offsetWidth: number;
  containerWidth: number;
  radius: string;
};

const ROW_BOX_SCRIPT = `(() => {
  const out = [];
  for (const row of document.querySelectorAll(".shell-ch-row")) {
    const parent = row.parentElement;
    out.push({
      active: row.getAttribute("aria-current"),
      offsetWidth: row.offsetWidth,
      containerWidth: parent ? parent.clientWidth : -1,
      radius: getComputedStyle(row).borderTopLeftRadius,
    });
  }
  return out;
})()`;

describeBrowser("composer layout", () => {
  const app = bootBrowserApp();

  test("long tokens wrap and sidebar rows go full-width", async () => {
    const { page, errors } = await app().newPage();
    try {
      await page.setViewport(VIEWPORT);
      await page.goto(app().origin, { waitUntil: "networkidle0" });
      await clickText(page, "button", "Create an account");
      await waitForText(page, "Create your account");
      await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
      await page.type("input[type=password]", "correct-horse-battery-staple");
      await page.click("button[type=submit]");

      // A placeholder key is enough: connecting stores a credential without
      // calling the provider, and creating a bench needs no inference.
      await waitForText(page, "Connect a brain");
      await clickText(page, "label", "Anthropic");
      await page.waitForSelector("input[type=password]");
      await page.type("input[type=password]", "sk-ant-placeholder");
      await clickText(page, "button", "Connect");

      // The new-workbench prompt is a bare composer: a long unbroken token
      // must wrap (no horizontal overflow) instead of scrolling.
      await page.waitForSelector(".chat-composer-input", { timeout: STEP_TIMEOUT });
      await page.type(".chat-composer-input", LONG_TOKEN);
      await page.waitForFunction(
        `(() => { const el = document.querySelector(".chat-composer-input"); return el !== null && el.scrollWidth <= el.clientWidth + 1; })()`,
        { timeout: STEP_TIMEOUT },
      );
      const overflowX = (await page.evaluate(
        `getComputedStyle(document.querySelector(".chat-composer-input")).overflowX`,
      )) as string;
      expect(overflowX).toBe("hidden");

      // Create the bench; its sidebar row is populated and active.
      await page.goto(`${app().origin}/new`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".chat-composer-input", { timeout: STEP_TIMEOUT });
      await page.type(".chat-composer-input", "Summarize what shipped this week");
      await page.click("button[aria-label='Start this workbench']");
      await page.waitForFunction(`location.pathname.startsWith("/w/")`, {
        timeout: STEP_TIMEOUT,
      });
      await page.waitForSelector(".shell-ch-row", { timeout: STEP_TIMEOUT });

      const rows = (await page.evaluate(ROW_BOX_SCRIPT)) as RowBox[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Math.abs(row.offsetWidth - row.containerWidth)).toBeLessThanOrEqual(1);
        expect(row.radius).not.toBe("0px");
      }
      expect(rows.some((row) => row.active === "true")).toBe(true);

      // Full-width did not smush the radius: it is stable under hover.
      const hovered = (await page.evaluate(
        `(() => { const row = document.querySelector(".shell-ch-row"); return row === null ? null : getComputedStyle(row).borderTopLeftRadius; })()`,
      )) as string | null;
      await page.hover(".shell-ch-row");
      const hoverRadius = (await page.evaluate(
        `(() => { const row = document.querySelector(".shell-ch-row:hover"); return row === null ? null : getComputedStyle(row).borderTopLeftRadius; })()`,
      )) as string | null;
      expect(hovered).not.toBeNull();
      expect(hoverRadius).toBe(hovered);
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `composer-layout failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 240_000);
});
