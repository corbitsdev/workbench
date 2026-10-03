import { describe, expect, test } from "bun:test";

import {
  dedupeMcpHandle,
  dedupeMcpName,
  displayNameFromUrl,
  handleFromUrl,
  redirectUrlName,
  suggestMcpServerName,
} from "./mcp-server-name";

describe("suggestMcpServerName", () => {
  test("prefers the server's title over its name", () => {
    expect(
      suggestMcpServerName({
        url: "https://mcp.linear.app/mcp",
        serverInfo: { name: "linear", title: "Linear (Corp)", version: "1.0" },
      }),
    ).toEqual({ name: "Linear (Corp)", source: "server" });
  });

  test("falls back to the server's name when there is no title", () => {
    expect(
      suggestMcpServerName({
        url: "https://mcp.linear.app/mcp",
        serverInfo: { name: "linear-proxy", version: "1.0" },
      }),
    ).toEqual({ name: "linear-proxy", source: "server" });
  });

  test("trims the server's name and ignores a blank one", () => {
    expect(
      suggestMcpServerName({
        url: "https://mcp.exa.ai/mcp",
        serverInfo: { name: "   ", version: "1.0" },
      }),
    ).toEqual({ name: "Exa", source: "url" });
    expect(
      suggestMcpServerName({
        url: "https://mcp.exa.ai/mcp",
        serverInfo: { name: "  Exa Search  " },
      }),
    ).toEqual({ name: "Exa Search", source: "server" });
  });

  test("ignores a non-string or missing server name", () => {
    expect(
      suggestMcpServerName({
        url: "https://mcp.exa.ai/mcp",
        serverInfo: { name: 42, version: "1.0" },
      }),
    ).toEqual({ name: "Exa", source: "url" });
    expect(suggestMcpServerName({ url: "https://mcp.exa.ai/mcp", serverInfo: {} })).toEqual({
      name: "Exa",
      source: "url",
    });
    expect(suggestMcpServerName({ url: "https://mcp.exa.ai/mcp" })).toEqual({
      name: "Exa",
      source: "url",
    });
  });

  test("caps an overlong server name", () => {
    const { name } = suggestMcpServerName({
      url: "https://mcp.example.com/mcp",
      serverInfo: { name: ` ${"n".repeat(200)} ` },
    });
    expect(name.length).toBeLessThanOrEqual(60);
  });

  test("reads a display name off the URL host", () => {
    expect(suggestMcpServerName({ url: "https://mcp.linear.app/mcp" })).toEqual({
      name: "Linear",
      source: "url",
    });
    expect(suggestMcpServerName({ url: "  https://www.mcp.exa.ai:443/mcp  " })).toEqual({
      name: "Exa",
      source: "url",
    });
    expect(suggestMcpServerName({ url: "https://my-cool-server.example.com/mcp" })).toEqual({
      name: "My Cool Server",
      source: "url",
    });
  });

  test("names bare hosts and IPs whole", () => {
    expect(suggestMcpServerName({ url: "http://localhost:3000/mcp" })).toEqual({
      name: "Localhost",
      source: "url",
    });
    expect(suggestMcpServerName({ url: "http://127.0.0.1:3000/mcp" })).toEqual({
      name: "127.0.0.1",
      source: "url",
    });
  });

  test("falls back when the URL is empty or invalid", () => {
    expect(suggestMcpServerName({ url: "" })).toEqual({ name: "MCP server", source: "fallback" });
    expect(suggestMcpServerName({ url: "   " })).toEqual({
      name: "MCP server",
      source: "fallback",
    });
    expect(suggestMcpServerName({ url: "not a url" })).toEqual({
      name: "MCP server",
      source: "fallback",
    });
  });

  test("dedupes against connected servers case-insensitively", () => {
    expect(
      suggestMcpServerName({
        url: "https://mcp.linear.app/mcp",
        existingNames: ["Linear"],
      }),
    ).toEqual({ name: "Linear 2", source: "url" });
    expect(
      suggestMcpServerName({
        url: "https://mcp.linear.app/mcp",
        serverInfo: { name: "Linear" },
        existingNames: ["linear", "Linear 2"],
      }),
    ).toEqual({ name: "Linear 3", source: "server" });
  });
});

describe("displayNameFromUrl", () => {
  test("returns null for empty and invalid input", () => {
    expect(displayNameFromUrl("")).toBeNull();
    expect(displayNameFromUrl("::not a url::")).toBeNull();
  });
});

describe("handleFromUrl", () => {
  test("slugs the host's distinctive label", () => {
    expect(handleFromUrl("https://mcp.linear.app/mcp")).toBe("linear");
    expect(handleFromUrl("https://www.mcp.exa.ai/mcp")).toBe("exa");
    expect(handleFromUrl("https://my-cool-server.example.com/mcp")).toBe("my-cool-server");
  });

  test("trims and returns null for empty or invalid input", () => {
    expect(handleFromUrl("  https://mcp.linear.app/mcp  ")).toBe("linear");
    expect(handleFromUrl("")).toBeNull();
    expect(handleFromUrl("not a url")).toBeNull();
  });
});

describe("redirectUrlName", () => {
  test("extracts a display name from a pasted URL and dedupes it", () => {
    expect(redirectUrlName("https://mcp.linear.app/mcp", [])).toBe("Linear");
    expect(redirectUrlName("  https://mcp.linear.app/mcp  ", ["Linear"])).toBe("Linear 2");
  });

  test("leaves plain names, blanks, and non-URLs alone", () => {
    expect(redirectUrlName("Linear", [])).toBeNull();
    expect(redirectUrlName("", [])).toBeNull();
    expect(redirectUrlName("not a url", [])).toBeNull();
  });
});

describe("dedupeMcpName", () => {
  test("leaves a unique name alone and numbers collisions", () => {
    expect(dedupeMcpName("Exa", ["Linear"])).toBe("Exa");
    expect(dedupeMcpName("Exa", ["exa"])).toBe("Exa 2");
    expect(dedupeMcpName("Exa", ["Exa", "Exa 2"])).toBe("Exa 3");
  });
});

describe("dedupeMcpHandle", () => {
  test("leaves a unique handle alone and dashes collisions", () => {
    expect(dedupeMcpHandle("mcp", ["linear"])).toBe("mcp");
    expect(dedupeMcpHandle("mcp", ["MCP"])).toBe("mcp-2");
    expect(dedupeMcpHandle("mcp", ["mcp", "mcp-2"])).toBe("mcp-3");
  });
});
