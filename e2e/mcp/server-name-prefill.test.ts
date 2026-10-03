// The Tools page's name pre-fill for "Add a server by URL": pasting a URL
// fills the name from the URL host, "Look up name" swaps in the server's own
// serverInfo, typed text is never overwritten (clearing falls back to the
// suggestion), a URL pasted into the name field is redirected rather than
// saved raw, a second identical add dedupes, and the stored names match.
// The fake server is keyless on loopback: it answers discovery with no
// bearer, so both the lookup and the keyless Add flow reach it.
import { afterAll, expect, test } from "bun:test";
import { type } from "arktype";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, runFirstRunFlow, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const NAME_INPUT = "input[aria-label='Server name']";
const URL_INPUT = "input[aria-label='Server URL']";
const HINT = ".tool-add-actions .tool-tile-hint";

function startFakeKeylessMcpServer() {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp" && req.method === "POST") {
        const rpc = (await req.json()) as { id?: number; method: string };
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        if (rpc.method === "initialize") {
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "acme", version: "1.0.0" },
            },
          });
        }
        if (rpc.method === "tools/list") {
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: [
                {
                  name: "acme.list_things",
                  description: "List things",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, origin: `http://127.0.0.1:${String(server.port)}` };
}

describeBrowser("mcp server name prefill", () => {
  const fake = startFakeKeylessMcpServer();
  const app = bootBrowserApp();
  afterAll(async () => {
    await fake.server.stop(true);
  });

  test("prefill → look-up → edit-stays → dedupe → stored name", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFirstRunFlow(page, app().origin);
      // Capture the workspace catalog read once, rather than tracking unrelated later requests.
      const [credentialsRequest] = await Promise.all([
        page.waitForRequest(
          (request) =>
            request.method() === "GET" &&
            /\/api\/tenants\/[^/]+\/credentials$/.test(new URL(request.url()).pathname),
          { timeout: STEP_TIMEOUT },
        ),
        page.goto(`${app().origin}/tools`, { waitUntil: "domcontentloaded" }),
      ]);
      const credentialsPath = new URL(credentialsRequest.url()).pathname;
      const serverUrl = `${fake.origin}/mcp`;

      const nameValue = () =>
        page.evaluate(
          `document.querySelector(${JSON.stringify(NAME_INPUT)}).value`,
        ) as Promise<string>;
      const hintText = () =>
        page.evaluate(
          `document.querySelector(${JSON.stringify(HINT)}).textContent ?? ""`,
        ) as Promise<string>;
      const storedNames = async () =>
        type("string[]").assert(
          await page.evaluate(`(async () => {
            const response = await fetch(${JSON.stringify(credentialsPath)});
            if (!response.ok) throw new Error("Listing credentials failed");
            const creds = await response.json();
            return creds.data
              .filter((c) => c.metadata?.mcp?.url === ${JSON.stringify(serverUrl)})
              .map((c) => c.metadata.mcp.name);
          })()`),
        );
      async function clearName(): Promise<void> {
        await page.click(NAME_INPUT, { count: 3 });
        await page.keyboard.press("Backspace");
      }

      await page.waitForSelector(URL_INPUT, { timeout: STEP_TIMEOUT });

      // Pasting the URL pre-fills the name from the host (loopback names itself whole).
      await page.type(URL_INPUT, serverUrl);
      await page.waitForFunction(
        `document.querySelector(${JSON.stringify(NAME_INPUT)}).value === "127.0.0.1"`,
        { timeout: STEP_TIMEOUT },
      );
      expect(await hintText()).toContain("Suggested from the URL");

      // "Look up name" swaps in the server's self-reported serverInfo.
      await clickText(page, ".tool-add-actions button", "Look up name");
      await page.waitForFunction(
        `document.querySelector(${JSON.stringify(NAME_INPUT)}).value === "acme"`,
        { timeout: STEP_TIMEOUT },
      );
      expect(await hintText()).toContain("From the server itself");

      // Typed text is never overwritten by a suggestion.
      await page.click(NAME_INPUT, { count: 3 });
      await page.type(NAME_INPUT, "Custom Acme");
      await Bun.sleep(500);
      expect(await nameValue()).toBe("Custom Acme");
      expect(await hintText()).toBe("Custom name.");

      // Clearing falls back to the suggestion for the save.
      await clearName();
      expect(await nameValue()).toBe("");
      expect(await hintText()).toBe('Will be saved as "acme".');

      // A URL pasted into the name field is redirected, never saved raw.
      await page.type(NAME_INPUT, serverUrl);
      await page.waitForFunction(`document.body.innerText.includes("Looks like a URL")`, {
        timeout: STEP_TIMEOUT,
      });
      expect(await hintText()).toBe('Looks like a URL — will be saved as "127.0.0.1".');
      await clearName();
      expect(await hintText()).toBe('Will be saved as "acme".');

      // Adding stores the suggestion; the tile shows it live.
      await clickText(page, ".tool-add-actions button", "Add");
      await page.waitForFunction(`document.body.innerText.includes("1 tools live")`, {
        timeout: 120_000,
        polling: 500,
      });
      await waitForText(page, "acme");
      expect(await storedNames()).toEqual(["acme"]);

      // Adding the same URL again dedupes against the stored name.
      await page.type(URL_INPUT, serverUrl);
      await page.waitForFunction(
        `document.querySelector(${JSON.stringify(NAME_INPUT)}).value === "127.0.0.1"`,
        { timeout: STEP_TIMEOUT },
      );
      await clickText(page, ".tool-add-actions button", "Look up name");
      await page.waitForFunction(
        `document.querySelector(${JSON.stringify(NAME_INPUT)}).value === "acme 2"`,
        { timeout: STEP_TIMEOUT },
      );
      await clickText(page, ".tool-add-actions button", "Add");
      await waitForText(page, "acme 2");
      expect((await storedNames()).sort()).toEqual(["acme", "acme 2"]);
    } catch (cause) {
      process.stderr.write(
        `server-name-prefill failed at ${page.url()}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    } finally {
      await page.close();
    }
  }, 600_000);
});
