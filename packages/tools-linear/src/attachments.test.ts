import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import { lastBody, makeFetchStub, makeRoutingFetchStub } from "./test-helpers";

describe("linear_get_attachment", () => {
  it("fetches attachment by id", async () => {
    const attachment = { id: "a1", title: "doc", url: "https://x" };
    const fetcher = makeFetchStub({ data: { attachment } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "1", name: "linear_get_attachment", arguments: { id: "a1" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(attachment);
    expect(lastBody(fetcher).query).toContain("attachment(id:");
  });
});

describe("linear_prepare_attachment_upload", () => {
  it("runs fileUpload mutation and returns issue metadata", async () => {
    const fetcher = makeFetchStub({
      data: {
        fileUpload: {
          success: true,
          uploadFile: { uploadUrl: "https://up", assetUrl: "https://asset" },
        },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "1",
        name: "linear_prepare_attachment_upload",
        arguments: {
          issue: "iss-1",
          filename: "f.png",
          contentType: "image/png",
          size: 1024,
        },
      },
      new AbortController().signal,
    );

    const parsed = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >;
    expect(parsed.issue).toBe("iss-1");
    expect(parsed.title).toBe("f.png");
    const body = lastBody(fetcher);
    expect(body.query).toContain("fileUpload(");
    expect(body.variables).toEqual({
      filename: "f.png",
      contentType: "image/png",
      size: 1024,
    });
  });
});

describe("linear_create_attachment_from_upload", () => {
  it("runs attachmentCreate mutation", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "attachmentCreate",
        data: {
          attachmentCreate: {
            success: true,
            attachment: { id: "a1", url: "https://asset", title: "T" },
          },
        },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_create_attachment_from_upload",
        arguments: {
          issue: "iss-1",
          assetUrl: "https://asset",
          subtitle: "sub",
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("attachmentCreate(input:");
    expect(body.variables).toEqual({
      input: {
        issueId: "iss-1",
        url: "https://asset",
        title: "https://asset",
        subtitle: "sub",
      },
    });
  });
});
