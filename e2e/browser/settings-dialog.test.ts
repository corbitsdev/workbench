// The Settings dialog keeps its Insights section inline: clicking the
// section leaves the dialog mounted with the runs panel (no top-level
// navigation unmounting the dialog), and Close dismisses it.
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, runFirstRunFlow, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

// Reads the dialog's embedded chrome: any crumb link out to /insights or a
// host sidebar toggle would navigate (or flip) the page behind the dialog.
const EMBEDDED_CHROME_SCRIPT = `(() => {
  const dialog = document.querySelector(".settings-dialog");
  if (dialog === null) return null;
  return {
    crumbLink: dialog.querySelector('a[href^="/insights"]')?.getAttribute("href") ?? null,
    sidebarToggle: dialog.querySelector(".stage-sidebar-toggle") !== null,
  };
})()`;

describeBrowser("settings dialog", () => {
  const app = bootBrowserApp();

  test("the Insights section renders runs inline and Close dismisses", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFirstRunFlow(page, app().origin);

      // Open Settings over the workbench page; a cold load falls back to a
      // backdrop page and mounts the dialog on top.
      await page.goto(`${app().origin}/settings`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".settings-dialog", { timeout: STEP_TIMEOUT });
      await waitForText(page, "Settings");

      // Click the Insights section: the section button must not close the
      // dialog (the regression), so the dialog stays mounted at /settings
      // with the runs panel rendered inline.
      await clickText(page, ".settings-nav button", "Insights");
      await page.waitForFunction(
        `location.pathname.startsWith("/settings") && document.querySelector(".settings-dialog") !== null && document.body.innerText.includes("Run history")`,
        { timeout: STEP_TIMEOUT },
      );

      const chrome = (await page.evaluate(EMBEDDED_CHROME_SCRIPT)) as {
        crumbLink: string | null;
        sidebarToggle: boolean;
      } | null;
      expect(chrome).toEqual({ crumbLink: null, sidebarToggle: false });

      // Close dismisses the dialog back to the page behind it.
      await page.click('.settings-dialog [aria-label="Close"]');
      await page.waitForFunction(`document.querySelector(".settings-dialog") === null`, {
        timeout: STEP_TIMEOUT,
      });
      expect(new URL(page.url()).pathname.startsWith("/settings")).toBe(false);
    } catch (cause) {
      process.stderr.write(
        `settings-dialog failed at ${page.url()}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 240_000);
});
