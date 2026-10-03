// The Tools page's Popular section lists the official MCP catalog as icon
// tiles in a dense multi-column grid: every tile carries an icon mark and the
// grid fills a standard viewport with more than one column.
import { expect, test } from "bun:test";
import { type } from "arktype";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { runFirstRunFlow, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

describeBrowser("tools popular grid", () => {
  const app = bootBrowserApp();

  test("popular servers render with icons in a dense grid", async () => {
    const { page, errors } = await app().newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await runFirstRunFlow(page, app().origin);
      await page.goto(`${app().origin}/tools`, { waitUntil: "domcontentloaded" });
      await waitForText(page, "Popular");

      const grid = type({
        columns: "number",
        gap: "string",
        tilePad: "string",
        tiles: type({ title: "string", icon: "boolean" }).array(),
        firstRow: "number",
        fullPack: "boolean",
      }).assert(
        await page.evaluate(`(() => {
          const gridEl = document.querySelector(".tools-grid");
          if (!gridEl) throw new Error("Popular grid did not render");
          const style = getComputedStyle(gridEl);
          const items = Array.from(gridEl.children).map((child) => ({
            top: Math.round(child.getBoundingClientRect().top),
            tile: child.classList.contains("tool-tile")
              ? {
                  title: child.querySelector(".tool-tile-title")?.textContent ?? "",
                  icon: child.querySelector(".tool-tile-mark svg") !== null,
                  pad: getComputedStyle(child).paddingTop,
                }
              : null,
          }));
          const columns = style.gridTemplateColumns.split(" ").filter((t) => t !== "").length;
          const perRow = new Map();
          for (const item of items) perRow.set(item.top, (perRow.get(item.top) ?? 0) + 1);
          const counts = [...perRow.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
          const firstTop = Math.min(...items.map((item) => item.top));
          const tiles = items.map((item) => item.tile).filter((tile) => tile !== null);
          return {
            columns,
            gap: style.gap,
            tilePad: tiles[0]?.pad ?? "",
            tiles: tiles.map(({ title, icon }) => ({ title, icon })),
            firstRow: items.filter((item) => item.top === firstTop).length,
            fullPack: counts.slice(0, -1).every((n) => n === columns),
          };
        })()`),
      );

      // Setup auto-connects keyless Exa, so a fresh workspace offers the rest
      // of the official catalog here; every tile wears its icon mark.
      expect(grid.tiles.length).toBeGreaterThanOrEqual(1);
      for (const tile of grid.tiles) expect(tile.icon).toBe(true);
      expect(
        grid.tiles.some((tile) =>
          ["Exa", "Linear", "Granola"].some((name) => tile.title.includes(name)),
        ),
      ).toBe(true);
      // Dense, not a single-column stack: several 200px tracks on a standard
      // viewport (the 12px gap and 16px tile padding fingerprint the new
      // CSS), a packed first row, and no holes before the final partial row.
      expect(grid.columns).toBeGreaterThanOrEqual(2);
      expect(grid.gap).toBe("12px");
      expect(grid.tilePad).toBe("16px");
      expect(grid.firstRow).toBeGreaterThanOrEqual(2);
      expect(grid.fullPack).toBe(true);
    } catch (cause) {
      process.stderr.write(
        `tools-popular failed at ${page.url()}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    } finally {
      await page.close();
    }
  }, 420_000);
});
