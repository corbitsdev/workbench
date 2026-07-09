import { describe, expect, mock, test } from "bun:test";
import * as intxDb from "@intx/db";
import { serializeWebSiteContent } from "@workbench/shared";

const resolveCredentialRequirement = (async () => ({
  secret: "vercel-key",
  providerId: "prov-vercel",
})) as unknown as typeof intxDb.resolveCredentialRequirement;

mock.module("@intx/db", () => ({
  ...intxDb,
  resolveCredentialRequirement,
}));

const { createVercelDeployArtifactTools } = await import(
  "./vercel-deploy-artifact"
);

describe("vercel_deploy_artifact", () => {
  test("rejects non-web kinds", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: "a1",
                kind: "document",
                content: "hello",
                version: 1,
              },
            ],
          }),
        }),
      }),
      query: {
        provider: {
          findFirst: async () => ({ metadata: {} }),
        },
      },
    } as never;

    const tool = createVercelDeployArtifactTools({ db, tenantId: "t1" })[0];
    if (!tool || tool.kind !== "string") throw new Error("missing tool");

    await expect(
      tool.handler(
        { artifactId: "a1", projectName: "demo" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/only web and web_site/);
  });

  test("rejects empty web artifact content", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { id: "a1", kind: "web", content: "   ", version: 1 },
            ],
          }),
        }),
      }),
      query: { provider: { findFirst: async () => ({ metadata: {} }) } },
    } as never;

    const tool = createVercelDeployArtifactTools({ db, tenantId: "t1" })[0];
    if (!tool || tool.kind !== "string") throw new Error("missing tool");

    await expect(
      tool.handler(
        { artifactId: "a1", projectName: "demo" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/empty/);
  });

  test("deploys web_site files to Vercel", async () => {
    const siteJson = serializeWebSiteContent({
      files: { "index.html": "<html>ok</html>", "app.js": "1" },
    });

    let posted: unknown;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: "a1",
                kind: "web_site",
                content: siteJson,
                version: 2,
              },
            ],
          }),
        }),
      }),
      query: {
        provider: {
          findFirst: async () => ({
            metadata: { baseURL: "https://api.vercel.com" },
          }),
        },
      },
    } as never;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        posted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ id: "dpl_x", url: "x.vercel.app" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    ) as typeof fetch;

    try {
      const tool = createVercelDeployArtifactTools({ db, tenantId: "t1" })[0];
      if (!tool || tool.kind !== "string") throw new Error("missing tool");

      const raw = await tool.handler(
        { artifactId: "a1", projectName: "my-site" },
        new AbortController().signal,
      );
      const parsed = JSON.parse(raw) as {
        artifactKind: string;
        fileCount: number;
        deployment: { url?: string };
      };

      expect(parsed.artifactKind).toBe("web_site");
      expect(parsed.fileCount).toBe(2);
      expect(parsed.deployment.url).toBe("https://x.vercel.app");
      expect(posted).toMatchObject({
        name: "my-site",
        files: expect.arrayContaining([
          expect.objectContaining({ file: "index.html" }),
          expect.objectContaining({ file: "app.js" }),
        ]),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
