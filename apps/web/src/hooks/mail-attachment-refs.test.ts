import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@workbench/chat";
import {
  buildAttachmentRefMap,
  isMailBlobId,
  mergeAttachmentRefs,
  upsertMailAttachmentRefs,
  type MailAttachmentRef,
} from "./mail-attachment-refs";

const refs: MailAttachmentRef[] = [
  {
    mailId: "mail-1",
    artifactId: "art-1",
    name: "report.pdf",
    type: "application/pdf",
    size: 100,
  },
  {
    mailId: "mail-1",
    artifactId: "art-2",
    name: "pic.png",
    type: "image/png",
    size: 50,
  },
  {
    mailId: "mail-2",
    artifactId: "art-3",
    name: "notes.txt",
    type: "text/plain",
    size: 10,
  },
];

describe("buildAttachmentRefMap", () => {
  it("groups refs by mailId as ChatAttachments keyed on artifactId", () => {
    const map = buildAttachmentRefMap(refs);
    expect(map.get("mail-1")).toEqual([
      { blobId: "art-1", name: "report.pdf", type: "application/pdf", size: 100 },
      { blobId: "art-2", name: "pic.png", type: "image/png", size: 50 },
    ]);
    expect(map.get("mail-2")).toEqual([
      { blobId: "art-3", name: "notes.txt", type: "text/plain", size: 10 },
    ]);
    expect(map.has("mail-9")).toBe(false);
  });
});

describe("mergeAttachmentRefs", () => {
  const messages: ChatMessage[] = [
    {
      id: "mail-1",
      role: "user",
      content: "here is a doc",
      createdAt: "2026-07-14T00:00:00.000Z",
    },
    {
      id: "turn-1",
      role: "agent",
      content: "thanks",
      createdAt: "2026-07-14T00:00:01.000Z",
    },
  ];

  it("attaches persisted refs to the bubble whose id matches the mailId", () => {
    const merged = mergeAttachmentRefs(messages, buildAttachmentRefMap(refs));
    expect(merged[0]!.attachments).toEqual([
      { blobId: "art-1", name: "report.pdf", type: "application/pdf", size: 100 },
      { blobId: "art-2", name: "pic.png", type: "image/png", size: 50 },
    ]);
    expect(merged[1]!.attachments).toBeUndefined();
  });

  it("does not duplicate an attachment the message already carries", () => {
    const withExisting: ChatMessage[] = [
      {
        ...messages[0]!,
        attachments: [
          {
            blobId: "art-1",
            name: "report.pdf",
            type: "application/pdf",
            size: 100,
          },
        ],
      },
    ];
    const merged = mergeAttachmentRefs(
      withExisting,
      buildAttachmentRefMap(refs),
    );
    expect(merged[0]!.attachments?.map((a) => a.blobId)).toEqual([
      "art-1",
      "art-2",
    ]);
  });

  it("returns the input array untouched when the map is empty", () => {
    const merged = mergeAttachmentRefs(messages, new Map());
    expect(merged).toBe(messages);
  });
});

describe("upsertMailAttachmentRefs", () => {
  it("appends new refs and replaces an existing (mailId, artifactId) pair", () => {
    const next = upsertMailAttachmentRefs(refs, [
      {
        mailId: "mail-1",
        artifactId: "art-1",
        name: "renamed.pdf",
        type: "application/pdf",
        size: 101,
      },
      {
        mailId: "mail-3",
        artifactId: "art-4",
        name: "new.csv",
        type: "text/csv",
        size: 5,
      },
    ]);
    expect(next).toHaveLength(4);
    expect(next.find((r) => r.artifactId === "art-1")?.name).toBe(
      "renamed.pdf",
    );
    expect(next.some((r) => r.artifactId === "art-4")).toBe(true);
  });

  it("handles an undefined previous list", () => {
    expect(upsertMailAttachmentRefs(undefined, [refs[0]!])).toEqual([refs[0]!]);
  });
});

describe("isMailBlobId", () => {
  it("recognizes interchange MIME-part blob ids", () => {
    expect(isMailBlobId("blob_mail-123_1.2")).toBe(true);
  });

  it("treats artifact UUIDs as non-blob ids", () => {
    expect(isMailBlobId("11111111-1111-1111-1111-111111111111")).toBe(false);
  });
});
