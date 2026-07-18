import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

let contextImpl: () => {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
} = () => ({
  context: { tenantId: "tn-1", principalId: "prn-1" },
  forbidden: false,
});
mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () => contextImpl(),
}));

import { createArtifactsRouter } from "./artifacts";

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
type MockDb = any;

function makeDb(opts: { artifact?: unknown; upload?: unknown }): HubDb {
  const db: MockDb = {
    query: {
      artifact: {
        findFirst: mock(() => Promise.resolve(opts.artifact ?? undefined)),
      },
      upload: {
        findFirst: mock(() => Promise.resolve(opts.upload ?? undefined)),
      },
    },
  };
  return db as HubDb;
}

function appWith(db: HubDb): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createArtifactsRouter(
      db,
      {} as unknown as Parameters<typeof createArtifactsRouter>[1],
    ),
  );
  return app;
}

const ARTIFACT_ROW = {
  id: "art-1",
  tenantId: "tn-1",
  principalId: null,
  ownerPrincipalId: null,
  sessionId: null,
  parentId: null,
  painPointId: null,
  kind: "file",
  title: "My Upload",
  content: "",
  source: { upload: { id: "up-1" } },
  status: "draft" as const,
  version: 1,
  createdAt: new Date("2026-06-20T00:00:00.000Z"),
  updatedAt: new Date("2026-06-20T00:00:00.000Z"),
};

function uploadRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "up-1",
    tenantId: "tn-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    content: Buffer.from("pdf-bytes"),
    ...overrides,
  };
}

describe("GET /artifacts/:id/download", () => {
  it("serves attachment disposition for a PDF without the inline param", async () => {
    const app = appWith(
      makeDb({ artifact: ARTIFACT_ROW, upload: uploadRow() }),
    );
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves inline disposition for a PDF with ?inline=1", async () => {
    const app = appWith(
      makeDb({ artifact: ARTIFACT_ROW, upload: uploadRow() }),
    );
    const res = await app.request("/artifacts/art-1/download?inline=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("inline");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("stays attachment for a non-PDF mime type even with ?inline=1", async () => {
    const app = appWith(
      makeDb({
        artifact: ARTIFACT_ROW,
        upload: uploadRow({ mimeType: "image/png", filename: "pic.png" }),
      }),
    );
    const res = await app.request("/artifacts/art-1/download?inline=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("stays attachment for a PDF when the inline param is absent or malformed", async () => {
    const app = appWith(
      makeDb({ artifact: ARTIFACT_ROW, upload: uploadRow() }),
    );
    const resMissing = await app.request("/artifacts/art-1/download");
    expect(resMissing.headers.get("Content-Disposition")).toContain(
      "attachment",
    );
    const resMalformed = await app.request(
      "/artifacts/art-1/download?inline=true",
    );
    expect(resMalformed.headers.get("Content-Disposition")).toContain(
      "attachment",
    );
  });

  it("404s when the artifact does not exist", async () => {
    const app = appWith(makeDb({ artifact: undefined }));
    const res = await app.request("/artifacts/nope/download");
    expect(res.status).toBe(404);
  });

  it("403s when the artifact belongs to another tenant", async () => {
    const app = appWith(
      makeDb({
        artifact: { ...ARTIFACT_ROW, tenantId: "tn-other" },
        upload: uploadRow(),
      }),
    );
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(403);
  });

  // Chat-upload artifacts (POST /instances/:id/parse-file) carry their bytes
  // as a data: URL in `content` with no upload-table row — the download route
  // must decode and serve them so persisted attachment chips stay downloadable
  // after reload.
  describe("data-URL file artifacts (chat uploads)", () => {
    const PAYLOAD = Buffer.from("hello-doc");
    const DATA_URL_ROW = {
      ...ARTIFACT_ROW,
      kind: "file",
      title: "notes.pdf",
      content: `data:application/pdf;base64,${PAYLOAD.toString("base64")}`,
      source: {
        origin: "imported",
        upload: { filename: "notes.pdf", mimeType: "application/pdf" },
      },
    };

    it("serves the decoded bytes with the stored mime type", async () => {
      const app = appWith(makeDb({ artifact: DATA_URL_ROW }));
      const res = await app.request("/artifacts/art-1/download");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PAYLOAD);
    });

    it("serves inline disposition for a PDF with ?inline=1", async () => {
      const app = appWith(makeDb({ artifact: DATA_URL_ROW }));
      const res = await app.request("/artifacts/art-1/download?inline=1");
      expect(res.headers.get("Content-Disposition")).toContain("inline");
    });

    it("stays attachment for a non-PDF data URL even with ?inline=1", async () => {
      const app = appWith(
        makeDb({
          artifact: {
            ...DATA_URL_ROW,
            title: "pic.png",
            content: `data:image/png;base64,${PAYLOAD.toString("base64")}`,
          },
        }),
      );
      const res = await app.request("/artifacts/art-1/download?inline=1");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });

    it("still 400s for a file artifact whose content is not a data URL", async () => {
      const app = appWith(
        makeDb({
          artifact: { ...DATA_URL_ROW, content: "not-a-data-url" },
        }),
      );
      const res = await app.request("/artifacts/art-1/download");
      expect(res.status).toBe(400);
    });

    // CL-3906: an imported image carries kind "image" (not "file") so it
    // renders inline; the download route must still decode its data: URL
    // rather than falling through to the CSV-only DOWNLOADABLE_ARTIFACT_KINDS
    // check and 400ing, since ImageBody's <img> fetches this same route.
    it("serves an imported image (kind 'image') data URL, not a 400 (CL-3906)", async () => {
      const app = appWith(
        makeDb({
          artifact: {
            ...DATA_URL_ROW,
            kind: "image",
            title: "screenshot.png",
            content: `data:image/png;base64,${PAYLOAD.toString("base64")}`,
          },
        }),
      );
      const res = await app.request("/artifacts/art-1/download");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PAYLOAD);
    });
  });
});
