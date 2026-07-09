import { describe, expect, test } from "bun:test";
import { deployStaticFilesToVercel } from "./deploy";

describe("deployStaticFilesToVercel", () => {
  test("posts multiple base64-encoded files", async () => {
    let body: unknown;
    const fetcher = async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ id: "dpl_1", url: "site.vercel.app" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await deployStaticFilesToVercel(
      { apiKey: "tok", fetcher },
      {
        projectName: "my-site",
        files: [
          { path: "index.html", content: "<html></html>" },
          { path: "assets/a.css", content: "body{}" },
        ],
        target: "preview",
      },
      new AbortController().signal,
    );

    expect(result.id).toBe("dpl_1");
    expect(result.url).toBe("https://site.vercel.app");
    expect(body).toMatchObject({
      name: "my-site",
      target: "preview",
      files: [
        { file: "index.html", encoding: "base64" },
        { file: "assets/a.css", encoding: "base64" },
      ],
    });
  });

  test("defaults deployment target to preview when omitted", async () => {
    let body: { target?: string } = {};
    const fetcher = async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as { target?: string };
      return new Response(JSON.stringify({ id: "dpl_2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await deployStaticFilesToVercel(
      { apiKey: "tok", fetcher },
      { projectName: "x", files: [{ path: "index.html", content: "ok" }] },
      new AbortController().signal,
    );

    expect(body.target).toBe("preview");
  });
});
