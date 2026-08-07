import { describe, expect, test } from "bun:test";
import {
  decodeMail,
  decodeParts,
  encodeParts,
  type FetchBlob,
  type MailContent,
  type MailReadContent,
} from "../src/codec";
import type { Part } from "../src/parts";

const allPartKinds: Part[] = [
  { kind: "text", text: "hello there" },
  { kind: "reasoning", text: "considering options" },
  {
    kind: "tool-trace",
    name: "search",
    input: { query: "workbench" },
    output: { results: ["a", "b"] },
    status: "success",
  },
  {
    kind: "block",
    block: { type: "poll", data: { options: ["yes", "no"] } },
  },
  {
    kind: "file",
    name: "report.pdf",
    mediaType: "application/pdf",
    blobId: "blob_abc_1",
  },
  {
    kind: "event",
    event: "member.joined",
    data: { userId: "u_1" },
  },
];

describe("encodeParts / decodeParts", () => {
  test("a lone TextPart encodes to bare content with no attachments", () => {
    const mail = encodeParts([{ kind: "text", text: "hello" }]);
    expect(mail).toEqual({ content: "hello" });
  });

  test("every part kind round-trips losslessly through encode/decode", () => {
    const mail = encodeParts(allPartKinds);
    const decoded = decodeParts(mail);
    expect(decoded).toEqual(allPartKinds);
  });

  test("multiple text parts encode as attachments, not bare content", () => {
    const parts: Part[] = [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ];
    const mail = encodeParts(parts);
    expect(mail.attachments).toHaveLength(2);
    expect(decodeParts(mail)).toEqual(parts);
  });

  test("a single non-text part still encodes as an attachment", () => {
    const parts: Part[] = [{ kind: "reasoning", text: "thinking" }];
    const mail = encodeParts(parts);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments?.[0]?.mimeType).toBe("application/json");
    expect(decodeParts(mail)).toEqual(parts);
  });

  test("bare text mail with no attachments decodes to a single TextPart", () => {
    const mail: MailContent = { content: "sent from a plain mail client" };
    expect(decodeParts(mail)).toEqual([
      { kind: "text", text: "sent from a plain mail client" },
    ]);
  });

  test("mail with an empty attachments array decodes as bare text", () => {
    const mail: MailContent = { content: "still bare", attachments: [] };
    expect(decodeParts(mail)).toEqual([{ kind: "text", text: "still bare" }]);
  });

  test("decode rejects an attachment with an unsupported MIME type", () => {
    const mail: MailContent = {
      content: "",
      attachments: [
        {
          mimeType: "application/octet-stream",
          data: Buffer.from("whatever").toString("base64"),
          name: "part-0.bin",
        },
      ],
    };
    expect(() => decodeParts(mail)).toThrow(/unsupported MIME type/);
  });

  test("decode rejects an application/json attachment with malformed JSON", () => {
    const mail: MailContent = {
      content: "",
      attachments: [
        {
          mimeType: "application/json",
          data: Buffer.from("{not json").toString("base64"),
          name: "part-0.json",
        },
      ],
    };
    expect(() => decodeParts(mail)).toThrow(/not valid JSON/);
  });

  test("decode rejects an application/json attachment that is not a valid Part", () => {
    const mail: MailContent = {
      content: "",
      attachments: [
        {
          mimeType: "application/json",
          data: Buffer.from(JSON.stringify({ kind: "nonsense" })).toString(
            "base64",
          ),
          name: "part-0.json",
        },
      ],
    };
    expect(() => decodeParts(mail)).toThrow(/invalid chat part/);
  });
});

describe("decodeMail", () => {
  function fakeFetchBlob(blobs: Record<string, string>): FetchBlob {
    return async (blobId: string) => {
      const blob = blobs[blobId];
      if (blob === undefined) {
        throw new Error(`no fixture blob for "${blobId}"`);
      }
      return blob;
    };
  }

  test("bare text mail from a non-chat sender decodes to a single TextPart", async () => {
    const mail: MailReadContent = {
      textBody: [{ partId: "1", type: "text/plain" }],
      bodyValues: { "1": { value: "sent from a plain mail client" } },
      attachments: [],
    };
    const parts = await decodeMail(mail, { fetchBlob: fakeFetchBlob({}) });
    expect(parts).toEqual([
      { kind: "text", text: "sent from a plain mail client" },
    ]);
  });

  test("every Part kind round-trips through the JMAP read shape", async () => {
    const toolTrace: Part = {
      kind: "tool-trace",
      name: "search",
      input: { query: "workbench" },
      output: { results: ["a", "b"] },
      status: "success",
    };
    const block: Part = {
      kind: "block",
      block: { type: "poll", data: { options: ["yes", "no"] } },
    };
    const event: Part = {
      kind: "event",
      event: "member.joined",
      data: { userId: "u_1" },
    };
    const reasoning: Part = { kind: "reasoning", text: "considering options" };

    const mail: MailReadContent = {
      textBody: [{ partId: "1", type: "text/plain" }],
      bodyValues: { "1": { value: "hello there" } },
      attachments: [
        {
          blobId: "blob_m1_2",
          name: "reasoning.json",
          type: "application/json",
          size: 1,
        },
        {
          blobId: "blob_m1_3",
          name: "trace.json",
          type: "application/json",
          size: 1,
        },
        {
          blobId: "blob_m1_4",
          name: "block.json",
          type: "application/json",
          size: 1,
        },
        {
          blobId: "blob_m1_5",
          name: "event.json",
          type: "application/json",
          size: 1,
        },
        {
          blobId: "blob_m1_6",
          name: "report.pdf",
          type: "application/pdf",
          size: 4096,
        },
        {
          blobId: "blob_m1_7",
          name: "note.txt",
          type: "text/plain",
          size: 12,
        },
      ],
    };

    const fetched: string[] = [];
    const fetchBlob: FetchBlob = async (blobId) => {
      fetched.push(blobId);
      const blobs: Record<string, string> = {
        blob_m1_2: JSON.stringify(reasoning),
        blob_m1_3: JSON.stringify(toolTrace),
        blob_m1_4: JSON.stringify(block),
        blob_m1_5: JSON.stringify(event),
        blob_m1_7: "a plain text attachment",
      };
      const blob = blobs[blobId];
      if (blob === undefined) {
        throw new Error(`no fixture blob for "${blobId}"`);
      }
      return blob;
    };

    const parts = await decodeMail(mail, { fetchBlob });

    expect(parts).toEqual([
      { kind: "text", text: "hello there" },
      reasoning,
      toolTrace,
      block,
      event,
      {
        kind: "file",
        name: "report.pdf",
        mediaType: "application/pdf",
        blobId: "blob_m1_6",
      },
      { kind: "text", text: "a plain text attachment" },
    ]);
    expect(fetched).not.toContain("blob_m1_6");
  });

  test("an attachment-only mail with empty body text produces no spurious TextPart", async () => {
    const mail: MailReadContent = {
      textBody: [{ partId: "1", type: "text/plain" }],
      bodyValues: { "1": { value: "" } },
      attachments: [
        { blobId: "blob_m2_2", name: "note.txt", type: "text/plain", size: 5 },
      ],
    };
    const parts = await decodeMail(mail, {
      fetchBlob: fakeFetchBlob({ blob_m2_2: "hello" }),
    });
    expect(parts).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("file attachments are never fetched, only referenced by blobId", async () => {
    const mail: MailReadContent = {
      textBody: [],
      bodyValues: {},
      attachments: [
        {
          blobId: "blob_m3_2",
          name: "photo.png",
          type: "image/png",
          size: 2048,
        },
      ],
    };
    const fetchBlob: FetchBlob = async () => {
      throw new Error(
        "fetchBlob should not be called for non-json/text attachments",
      );
    };
    const parts = await decodeMail(mail, { fetchBlob });
    expect(parts).toEqual([
      {
        kind: "file",
        name: "photo.png",
        mediaType: "image/png",
        blobId: "blob_m3_2",
      },
    ]);
  });

  test("decodeMail rejects a malformed application/json attachment loudly", async () => {
    const mail: MailReadContent = {
      textBody: [],
      bodyValues: {},
      attachments: [
        {
          blobId: "blob_m4_2",
          name: "bad.json",
          type: "application/json",
          size: 9,
        },
      ],
    };
    await expect(
      decodeMail(mail, {
        fetchBlob: fakeFetchBlob({ blob_m4_2: "{not json" }),
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("decodeMail rejects an application/json attachment that is not a valid Part", async () => {
    const mail: MailReadContent = {
      textBody: [],
      bodyValues: {},
      attachments: [
        {
          blobId: "blob_m5_2",
          name: "nonsense.json",
          type: "application/json",
          size: 9,
        },
      ],
    };
    await expect(
      decodeMail(mail, {
        fetchBlob: fakeFetchBlob({
          blob_m5_2: JSON.stringify({ kind: "nonsense" }),
        }),
      }),
    ).rejects.toThrow(/invalid chat part/);
  });

  test("decodeMail rejects a structurally invalid mail read shape", async () => {
    await expect(
      decodeMail({ textBody: [] }, { fetchBlob: fakeFetchBlob({}) }),
    ).rejects.toThrow(/invalid mail read content/);
  });
});
