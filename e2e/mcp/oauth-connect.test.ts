// Sign in to an OAuth MCP server from the Tools page: the hub runs the login
// against a fake authorization server, stores a stock oauth_token credential,
// the server's catalog lands in the workspace catalog, and deleting the
// credential breaks discovery. The fake server and its authorization server
// are one Bun.serve on loopback.
import { afterAll, expect, test } from "bun:test";
import { type } from "arktype";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, runFirstRunFlow, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const ACCESS_TOKEN = "acme-access-token";

function startFakeMcpServer() {
  let origin = "";
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
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register") {
        const body = (await req.json()) as { redirect_uris?: string[] };
        return json({ client_id: "acme-client", redirect_uris: body.redirect_uris ?? [] }, 201);
      }
      if (url.pathname === "/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "acme-code");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        return Response.redirect(redirect.toString(), 302);
      }
      if (url.pathname === "/token") {
        return json({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "acme-refresh-token",
        });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        if (req.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
          return new Response("unauthorized", { status: 401 });
        }
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
  origin = `http://127.0.0.1:${String(server.port)}`;
  return { server, origin };
}

describeBrowser("oauth mcp connect", () => {
  const fake = startFakeMcpServer();
  const app = bootBrowserApp();
  afterAll(async () => {
    await fake.server.stop(true);
  });

  test("sign in adds the server; revoking breaks discovery", async () => {
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
      await page.waitForSelector("input[aria-label='Server URL']", { timeout: STEP_TIMEOUT });
      await page.type("input[aria-label='Server URL']", `${fake.origin}/mcp`);
      // Register before clicking: the fake provider redirects immediately. With noopener,
      // use the callback URL rather than relying on the popup's opener relationship.
      const [callback] = await Promise.all([
        page.browserContext().waitForTarget(
          (target) => {
            if (!URL.canParse(target.url())) return false;
            const url = new URL(target.url());
            return (
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1"].includes(url.hostname) &&
              url.port === new URL(app().origin).port &&
              url.pathname === "/api/oauth/callback"
            );
          },
          { timeout: STEP_TIMEOUT },
        ),
        clickText(page, ".tool-add-actions button", "Sign in"),
      ]);
      const popup = await callback.page();
      if (popup === null) throw new Error("OAuth callback did not open a page");
      await waitForText(popup, "Signed in. You can close this tab.");
      await popup.close();
      // Model returning to Tools: its sign-in query does not poll while backgrounded.
      await page.bringToFront();
      await page.waitForFunction(`document.body.innerText.includes("1 tool live")`, {
        timeout: 120_000,
        polling: 500,
      });

      // Runs in the page so the signed-in session cookie applies.
      const result = type({
        auth: "string",
        tools: "string[]",
        before: "number",
        deleted: "boolean",
        after: "number",
      }).assert(
        await page.evaluate(`(async () => {
        const credentials = ${JSON.stringify(credentialsPath)};
        const response = await fetch(credentials);
        if (!response.ok) throw new Error("Listing credentials failed");
        const creds = await response.json();
        const row = creds.data.find((c) => c.metadata?.mcp?.url === ${JSON.stringify(`${fake.origin}/mcp`)});
        if (!row) throw new Error("Connected MCP credential not found");
        const discover = () => fetch(credentials.replace(/credentials$/, "mcp/discover"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: row.metadata.mcp.url, credentialId: row.id }),
        }).then((r) => r.status);
        const before = await discover();
        const deleted = (await fetch(credentials + "/" + row.id, { method: "DELETE" })).ok;
        const after = await discover();
        return { auth: row.metadata.mcp.auth, tools: row.metadata.mcp.tools.map((t) => t.name), before, deleted, after };
      })()`),
      );

      expect(result.auth).toBe("oauth");
      expect(result.tools).toEqual(["acme.list_things"]);
      expect(result.before).toBe(200);
      expect(result.deleted).toBe(true);
      expect(result.after).toBe(404);
    } catch (cause) {
      process.stderr.write(
        `oauth-connect failed at ${page.url()}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    } finally {
      await page.close();
    }
  }, 400_000);
});
