// `probeMcpServer` hands the Tools page the server's self-report, not the
// hub discovery envelope it arrives in: POST /mcp/discover nests the report
// beside the negotiated protocol version, and the name suggestion reads the
// report's own `title`/`name`.
import { describe, expect, test } from "bun:test";

import { probeMcpServer } from "./mcp-servers";
import { suggestMcpServerName } from "./mcp-server-name";

const TOOL = {
  name: "acme.list_things",
  description: "List things",
  inputSchema: { type: "object", properties: {} },
};

function discoverFetch(serverInfo: unknown): typeof fetch {
  const stub = async (): Promise<Response> =>
    new Response(JSON.stringify({ data: { serverInfo, tools: [TOOL] } }));
  // A bare stub never carries `fetch`'s static `preconnect` member.
  return Object.assign(stub, { preconnect: () => {} }) as typeof fetch;
}

describe("probeMcpServer", () => {
  test("unwraps the hub envelope to the server's self-reported serverInfo", async () => {
    const { serverInfo } = await probeMcpServer(
      { tenantId: "tnt_workspace", url: "https://mcp.acme.test/mcp" },
      discoverFetch({
        protocolVersion: "2025-03-26",
        serverInfo: { name: "acme", version: "1.0.0" },
      }),
    );
    expect(serverInfo).toEqual({ name: "acme", version: "1.0.0" });
    expect(suggestMcpServerName({ url: "https://mcp.acme.test/mcp", serverInfo })).toEqual({
      name: "acme",
      source: "server",
    });
  });

  test("passes a report-shaped answer through untouched", async () => {
    const { serverInfo } = await probeMcpServer(
      { tenantId: "tnt_workspace", url: "https://mcp.acme.test/mcp" },
      discoverFetch({ name: "acme", version: "1.0.0" }),
    );
    expect(serverInfo).toEqual({ name: "acme", version: "1.0.0" });
  });

  test("keeps an envelope with no inner report whole for the URL fallback", async () => {
    const { serverInfo } = await probeMcpServer(
      { tenantId: "tnt_workspace", url: "https://mcp.acme.test/mcp" },
      discoverFetch({ protocolVersion: "2025-03-26" }),
    );
    expect(serverInfo).toEqual({ protocolVersion: "2025-03-26" });
    expect(suggestMcpServerName({ url: "https://mcp.acme.test/mcp", serverInfo })).toEqual({
      name: "Acme",
      source: "url",
    });
  });
});
