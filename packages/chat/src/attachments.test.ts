import { describe, expect, it } from "bun:test";
import {
  formatBytes,
  validateFiles,
  type AttachmentPolicy,
  type PendingAttachment,
} from "./attachments";

const POLICY: AttachmentPolicy = {
  acceptedMimeTypes: ["image/png", "image/jpeg", "application/pdf"],
  perAttachmentLimitBytes: 10 * 1024 * 1024,
  perMessageTotalLimitBytes: 30 * 1024 * 1024,
};

function file(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], name, { type });
}

describe("validateFiles", () => {
  it("accepts an allowed file within limits", () => {
    const { accepted, errors } = validateFiles(
      [file("a.png", "image/png", 1000)],
      POLICY,
      [],
    );
    expect(errors).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.name).toBe("a.png");
    expect(accepted[0]?.mimeType).toBe("image/png");
  });

  it("rejects a disallowed MIME type, naming the file", () => {
    const { accepted, errors } = validateFiles(
      [file("clip.mp4", "video/mp4", 1000)],
      POLICY,
      [],
    );
    expect(accepted).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("clip.mp4");
  });

  it("rejects a file over the per-attachment limit", () => {
    const { accepted, errors } = validateFiles(
      [file("big.pdf", "application/pdf", 11 * 1024 * 1024)],
      POLICY,
      [],
    );
    expect(accepted).toHaveLength(0);
    expect(errors[0]).toContain("per-file limit");
  });

  it("rejects a file that would exceed the per-message total, counting existing", () => {
    const existing: PendingAttachment[] = [
      {
        id: "x",
        file: file("prior.pdf", "application/pdf", 25 * 1024 * 1024),
        name: "prior.pdf",
        mimeType: "application/pdf",
        size: 25 * 1024 * 1024,
      },
    ];
    const { accepted, errors } = validateFiles(
      [file("more.pdf", "application/pdf", 8 * 1024 * 1024)],
      POLICY,
      existing,
    );
    expect(accepted).toHaveLength(0);
    expect(errors[0]).toContain("total limit");
  });

  it("accepts the valid files and reports errors for the rest in one pass", () => {
    const { accepted, errors } = validateFiles(
      [file("ok.png", "image/png", 1000), file("no.gif", "image/gif", 1000)],
      POLICY,
      [],
    );
    expect(accepted.map((a) => a.name)).toEqual(["ok.png"]);
    expect(errors).toHaveLength(1);
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });
});
