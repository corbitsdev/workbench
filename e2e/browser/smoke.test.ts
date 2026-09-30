// The app loads from the hub's origin, the signed-out screen renders, and
// nothing logs a console error.
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";

const describeBrowser = browserGate(import.meta.path);

describeBrowser("smoke", () => {
  const app = bootBrowserApp();

  test("loads the signed-out screen with zero console errors", async () => {
    const { page, errors } = await app().newPage();
    await page.goto(app().origin, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=password]", { timeout: 15_000 });
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
