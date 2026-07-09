/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatInput } from "./ChatInput";
import type { AttachmentPolicy } from "./attachments";

// happy-dom may not implement object URLs; the image-preview branch needs them.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

const IMG_PDF_POLICY: AttachmentPolicy = {
  acceptedMimeTypes: ["image/png", "application/pdf"],
  perAttachmentLimitBytes: 10 * 1024 * 1024,
  perMessageTotalLimitBytes: 30 * 1024 * 1024,
};

function makeFile(name: string, mimeType: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type: mimeType });
}

function fileInputOf(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (input === null) throw new Error("no file input rendered");
  return input as HTMLInputElement;
}

afterEach(() => {
  cleanup();
});

describe("ChatInput", () => {
  it("sends the trimmed draft and clears the field on submit", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    await user.type(input, "  hi there  ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend.mock.calls[0]?.[0]).toBe("hi there");
    expect(input.value).toBe("");
  });

  it("submits on Enter without shift", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} />);

    await user.type(screen.getByLabelText("Message"), "quick{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("quick");
  });

  it("inserts a newline on Shift+Enter instead of sending", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toContain("\n");
  });

  it("does not send an empty/whitespace draft", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} />);

    await user.type(screen.getByLabelText("Message"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks submission and disables controls when disabled", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} disabled />);

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    await user.type(input, "nope{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a busy indicator, relabels the button, and blocks submission when busy", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} busy />);

    const button = screen.getByRole("button", {
      name: "Waiting for agent",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      (screen.getByLabelText("Message") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders a custom placeholder when provided", () => {
    render(<ChatInput onSend={() => {}} placeholder="Ask anything" />);
    expect(screen.getByPlaceholderText("Ask anything")).toBeDefined();
  });

  it("falls back to the default placeholder", () => {
    render(<ChatInput onSend={() => {}} />);
    expect(screen.getByPlaceholderText("Message Ada…")).toBeDefined();
  });

  it("hides the attach control when no attachment policy is given", () => {
    render(<ChatInput onSend={() => {}} />);
    expect(screen.queryByLabelText("Add files")).toBeNull();
  });

  it("adds a file chip when an allowed file is picked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    expect(screen.getByLabelText("Add files")).toBeDefined();
    await user.upload(
      fileInputOf(container),
      makeFile("brief.pdf", "application/pdf"),
    );
    expect(screen.getByText("brief.pdf")).toBeDefined();
  });

  it("sends the draft together with the attachment, then clears both", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string, _attachments?: unknown) => {});
    const { container } = render(
      <ChatInput onSend={onSend} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    await user.upload(
      fileInputOf(container),
      makeFile("brief.pdf", "application/pdf"),
    );
    await user.type(screen.getByLabelText("Message"), "look at this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend.mock.calls[0]?.[0]).toBe("look at this");
    const attachments = onSend.mock.calls[0]?.[1] as
      | { name: string }[]
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.name).toBe("brief.pdf");
    expect(screen.queryByText("brief.pdf")).toBeNull();
  });

  it("sends an attachment with no text", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string, _attachments?: unknown) => {});
    const { container } = render(
      <ChatInput onSend={onSend} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    await user.upload(
      fileInputOf(container),
      makeFile("brief.pdf", "application/pdf"),
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend.mock.calls[0]?.[0]).toBe("");
    expect(onSend.mock.calls[0]?.[1] as unknown[]).toHaveLength(1);
  });

  it("surfaces a legible error and adds no chip for a disallowed dropped file", () => {
    // The picker filters by `accept`; drag-drop can still deliver a disallowed
    // type, so client validation is the backstop for the drop path.
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    const dropZone = container.firstElementChild as HTMLElement;
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [makeFile("clip.mp4", "video/mp4")] },
    });
    expect(screen.getByRole("alert").textContent).toContain("clip.mp4");
    expect(screen.queryByLabelText("Remove clip.mp4")).toBeNull();
  });

  it("accepts an allowed dropped file as a chip", () => {
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    const dropZone = container.firstElementChild as HTMLElement;
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [makeFile("brief.pdf", "application/pdf")] },
    });
    expect(screen.getByText("brief.pdf")).toBeDefined();
  });

  it("removes a pending attachment on its remove button", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    await user.upload(
      fileInputOf(container),
      makeFile("brief.pdf", "application/pdf"),
    );
    await user.click(screen.getByLabelText("Remove brief.pdf"));
    expect(screen.queryByText("brief.pdf")).toBeNull();
  });

  it("renders an image preview thumbnail for an image attachment", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    await user.upload(
      fileInputOf(container),
      makeFile("shot.png", "image/png"),
    );
    expect(screen.getByAltText("shot.png")).toBeDefined();
  });

  it("does not light up the drop zone for a non-file drag", () => {
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    const zone = container.firstElementChild as HTMLElement;
    fireEvent.dragOver(zone, {
      dataTransfer: { types: ["text/plain"], files: [] },
    });
    expect(zone.className).not.toContain("ring-orange");
  });

  it("keeps a prior rejection when a valid file is added afterward", () => {
    const { container } = render(
      <ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />,
    );
    const zone = container.firstElementChild as HTMLElement;
    fireEvent.drop(zone, {
      dataTransfer: { files: [makeFile("clip.mp4", "video/mp4")] },
    });
    expect(screen.getByRole("alert").textContent).toContain("clip.mp4");
    fireEvent.drop(zone, {
      dataTransfer: { files: [makeFile("ok.png", "image/png")] },
    });
    expect(screen.getByRole("alert").textContent).toContain("clip.mp4");
    expect(screen.getByText("ok.png")).toBeDefined();
  });
});

describe("ChatInput composer width", () => {
  it("centers the input row within a capped max width by default", () => {
    render(<ChatInput onSend={() => {}} />);
    const row = screen.getByLabelText("Message").parentElement;
    expect(row?.className).toContain("mx-auto");
    expect(row?.className).toContain("max-w-[60vw]");
  });

  it("runs the input row full width (left-aligned) when fullWidth is set", () => {
    render(<ChatInput onSend={() => {}} fullWidth />);
    const row = screen.getByLabelText("Message").parentElement;
    expect(row?.className).not.toContain("mx-auto");
    expect(row?.className).not.toContain("max-w-[60vw]");
  });
});

describe("auto-grow", () => {
  it("grows textarea height when long multi-line text is pasted", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;

    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => 192,
    });

    const pasted =
      "Paragraph one that is long enough to wrap several times in the composer.\n" +
      "Paragraph two continues the paste.\nParagraph three.\nParagraph four.\n" +
      "Paragraph five with more text to force height growth.\nParagraph six.";

    await user.click(input);
    await user.paste(pasted);

    expect(input.value).toContain("Paragraph six");
    expect(parseInt(input.style.height || "0", 10)).toBeGreaterThan(100);
  });
});
