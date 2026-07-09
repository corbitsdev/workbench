import { describe, expect, test } from "bun:test";
import {
  buildWebSitePreviewHtml,
  expandWebArtifactToVercelFiles,
  parseWebSiteContentJson,
  serializeWebSiteContent,
  WEB_SITE_MAX_FILE_BYTES,
  WebSiteContentError,
} from "./web-site";

describe("web_site content", () => {
  test("parses and normalizes paths", () => {
    const raw = JSON.stringify({
      entry: "index.html",
      files: { "/index.html": "<html></html>", "styles/app.css": "body{}" },
    });
    const parsed = parseWebSiteContentJson(raw);
    expect(parsed.entry).toBe("index.html");
    expect(parsed.files["index.html"]).toBe("<html></html>");
    expect(parsed.files["styles/app.css"]).toBe("body{}");
  });

  test("rejects path traversal", () => {
    expect(() =>
      parseWebSiteContentJson(JSON.stringify({ files: { "../x.html": "x" } })),
    ).toThrow(WebSiteContentError);
  });

  test("rejects missing entry file", () => {
    expect(() =>
      parseWebSiteContentJson(
        JSON.stringify({ entry: "index.html", files: { "other.html": "x" } }),
      ),
    ).toThrow(/entry file/);
  });

  test("rejects oversize file", () => {
    expect(() =>
      parseWebSiteContentJson(
        JSON.stringify({
          files: { "index.html": "a".repeat(WEB_SITE_MAX_FILE_BYTES + 1) },
        }),
      ),
    ).toThrow(/max size/);
  });

  test("serialize round-trips through parse", () => {
    const content = {
      entry: "index.html",
      files: { "index.html": "<p>hi</p>", "a.css": "x" },
    };
    const json = serializeWebSiteContent(content);
    expect(parseWebSiteContentJson(json).files["index.html"]).toBe("<p>hi</p>");
  });

  test("expand web kind to single index.html", () => {
    expect(expandWebArtifactToVercelFiles("web", "<h1>x</h1>")).toEqual([
      { path: "index.html", content: "<h1>x</h1>" },
    ]);
  });

  test("expand web rejects whitespace-only content", () => {
    expect(() => expandWebArtifactToVercelFiles("web", "   \n")).toThrow(
      WebSiteContentError,
    );
  });

  test("buildWebSitePreviewHtml inlines same-bundle css and js refs", () => {
    const html = buildWebSitePreviewHtml({
      entry: "index.html",
      files: {
        "index.html":
          '<html><link href="app.css" rel="stylesheet"><script src="app.js"></script></html>',
        "app.css": "body{color:red}",
        "app.js": "console.log(1)",
      },
    });
    expect(html).toContain("data:text/css");
    expect(html).toContain("body%7Bcolor%3Ared%7D");
    expect(html).toContain("data:text/javascript");
    expect(html).not.toContain('href="app.css"');
    expect(html).not.toContain('src="app.js"');
  });

  test("expand web_site to all paths", () => {
    const json = serializeWebSiteContent({
      files: { "index.html": "<html></html>", "a.js": "1" },
    });
    const files = expandWebArtifactToVercelFiles("web_site", json);
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.path === "index.html")?.content).toBe(
      "<html></html>",
    );
  });
});
