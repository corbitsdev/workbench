// Sign in to an OAuth MCP server from the Tools page: the hub runs the login
// against a fake authorization server, stores a stock oauth_token credential,
// the server's catalog lands in the workspace catalog, and deleting the
// credential breaks discovery. The fake server and its authorization server
// are one Bun.serve on loopback.
import { afterAll, expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { runFirstRunFlow, STEP_TIMEOUT } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const ACCESS_TOKEN = "acme-access-token";

function startFakeMcpServer() {
  let origin = "";
  const seen = { authorizedCalls: 0, unauthorizedCalls: 0 };
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
          seen.unauthorizedCalls += 1;
          return new Response("unauthorized", { status: 401 });
        }
        seen.authorizedCalls += 1;
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
  return { server, origin, seen };
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
      // The catalog lives on the workspace tenant; its id shows up in the page's own reads.
      let workspaceId = "";
      page.on("request", (request) => {
        const match = /\/api\/tenants\/([^/]+)\/credentials$/.exec(new URL(request.url()).pathname);
        if (match?.[1] !== undefined) workspaceId = decodeURIComponent(match[1]);
      });
      await page.goto(`${app().origin}/tools`, { waitUntil: "networkidle0" });
      await page.waitForSelector("input[aria-label='Server URL']", { timeout: STEP_TIMEOUT });
      await page.type("input[aria-label='Server URL']", `${fake.origin}/mcp`);
      // The catalog tiles have Sign in buttons too; this one sits in the add-by-URL card.
      await page.evaluate(`(() => {
        const input = document.querySelector("input[aria-label='Server URL']");
        const button = Array.from(input.parentElement.querySelectorAll("button")).find(
          (b) => b.textContent.trim() === "Sign in",
        );
        button.click();
      })()`);
      // The sign-in tab takes the foreground, which pauses rAF polling here.
      // The tile appears once the catalog write and the Worker redeploy settle.
      await page.waitForFunction(`document.body.innerText.includes("1 tools live")`, {
        timeout: 120_000,
        polling: 500,
      });

      // Runs in the page so the signed-in session cookie applies.
      const result = (await page.evaluate(`(async () => {
        const workspace = ${JSON.stringify(workspaceId)};
        const creds = await (await fetch("/api/tenants/" + workspace + "/credentials")).json();
        const row = creds.data.find((c) => c.metadata?.mcp?.url?.endsWith("/mcp"));
        const discover = () => fetch("/api/tenants/" + workspace + "/mcp/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: row.metadata.mcp.url, credentialId: row.id }),
        }).then((r) => r.status);
        const before = await discover();
        await fetch("/api/tenants/" + workspace + "/credentials/" + row.id, { method: "DELETE" });
        const after = await discover();
        return { type: row.type, meta: row.metadata, before, after };
      })()`)) as {
        type: string;
        meta: { mcp: { auth: string; tools: { name: string }[] }; oauthClientId?: string };
        before: number;
        after: number;
      };

      expect(result.type).toBe("oauth_token");
      expect(result.meta.mcp.auth).toBe("oauth");
      expect(result.meta.mcp.tools.map((t) => t.name)).toEqual(["acme.list_things"]);
      expect(result.meta.oauthClientId).toBe("acme-client");
      expect(result.before).toBe(200);
      expect(result.after).not.toBe(200);
      expect(fake.seen.authorizedCalls).toBeGreaterThan(0);
    } catch (cause) {
      process.stderr.write(
        `oauth-connect failed at ${page.url()}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 400_000);
});
