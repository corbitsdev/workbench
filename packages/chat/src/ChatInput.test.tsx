/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function pasteFilesOn(textarea: HTMLTextAreaElement, files: File[]) {
  fireEvent.paste(textarea, {
    clipboardData: {
      files,
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
      types: ["Files"],
      getData: () => "",
    },
  });
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

  it("shows a busy spinner, relabels the button, and blocks submission when busy", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} busy />);

    const button = screen.getByRole("button", {
      name: "Waiting for agent",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Busy state reads as active work — a spinner, not greyed-out dots.
    expect(screen.getByTestId("composer-busy-spinner")).toBeDefined();
    expect(
      (screen.getByLabelText("Message") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders the send control as an icon button, not a text label", () => {
    render(<ChatInput onSend={() => {}} />);
    // Accessible name stays "Send"; the visible label is an icon.
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    expect(screen.queryByText("Send")).toBeNull();
  });

  it("renders a custom placeholder when provided", () => {
    render(<ChatInput onSend={() => {}} placeholder="Ask anything" />);
    expect(screen.getByPlaceholderText("Ask anything")).toBeDefined();
  });

  it("falls back to an agent-neutral placeholder", () => {
    // The fallback must never name a specific agent — hosts pass the bound
    // agent's name via `placeholder`.
    render(<ChatInput onSend={() => {}} />);
    expect(screen.getByPlaceholderText("Message…")).toBeDefined();
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

  it("adds a chip when an allowed image is pasted from the clipboard (Ctrl+V)", () => {
    render(<ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    pasteFilesOn(textarea, [makeFile("screenshot.png", "image/png")]);
    expect(screen.getByText("screenshot.png")).toBeDefined();
    expect(textarea.value).toBe("");
  });

  it("leaves plain-text paste unchanged when the clipboard has no files", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} attachmentPolicy={IMG_PDF_POLICY} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    await user.click(textarea);
    await user.paste("hello from clipboard");
    expect(textarea.value).toBe("hello from clipboard");
    expect(screen.queryByLabelText(/Remove/)).toBeNull();
  });

  it("removes a pasted attachment via its remove button", () => {
    render(<ChatInput onSend={() => {}} attachmentPolicy={IMG_PDF_POLICY} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    pasteFilesOn(textarea, [makeFile("paste.png", "image/png")]);
    fireEvent.click(screen.getByLabelText("Remove paste.png"));
    expect(screen.queryByText("paste.png")).toBeNull();
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

  it("grows up to ~30vh but caps height and lets internal scroll take over for longer content", () => {
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;

    // Simulate a ~1000px viewport so 30vh = 300px cap.
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      get: () => 1000,
    });

    // Very tall content.
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => 600,
    });

    // Trigger height adjustment by typing (onChange + useLayoutEffect).
    fireEvent.change(input, { target: { value: "x\ny\nz\nlong\ncontent" } });

    const h = parseInt(input.style.height || "0", 10);
    const expectedCap = Math.floor(1000 * 0.3);
    // Must be capped (not the full 600).
    expect(h).toBeLessThanOrEqual(expectedCap);
    expect(h).toBeGreaterThan(100); // still grew some
    // The element's internal scrollHeight (mock) exceeds the rendered height => scroll will appear.
    expect(input.scrollHeight).toBeGreaterThan(h);
  });
});

describe("ChatInput abort (stop button)", () => {
  it("shows an enabled Stop control instead of the disabled spinner while busy with onAbort", () => {
    render(<ChatInput onSend={() => {}} onAbort={() => {}} busy />);

    const stop = screen.getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    // The stop control replaces the spinner — it reads as an action, not a wait.
    expect(screen.queryByTestId("composer-busy-spinner")).toBeNull();
  });

  it("keeps the plain send control when idle even with onAbort provided", () => {
    render(<ChatInput onSend={() => {}} onAbort={() => {}} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("keeps the busy spinner when no onAbort is provided", () => {
    render(<ChatInput onSend={() => {}} busy />);
    expect(screen.getByTestId("composer-busy-spinner")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("fires onAbort when the stop button is clicked", async () => {
    const user = userEvent.setup();
    const onAbort = mock(() => {});
    render(<ChatInput onSend={() => {}} onAbort={onAbort} busy />);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("disables the stop button while an abort is in flight and re-enables after it settles", async () => {
    const user = userEvent.setup();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const onAbort = mock(() => gate);
    render(<ChatInput onSend={() => {}} onAbort={onAbort} busy />);

    const stop = screen.getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;
    await user.click(stop);
    expect(stop.disabled).toBe(true);
    // A second click while pending must not double-fire.
    fireEvent.click(stop);
    expect(onAbort).toHaveBeenCalledTimes(1);

    release();
    await gate;
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("surfaces a rejected abort as a composer error and re-enables the stop button", async () => {
    const user = userEvent.setup();
    const onAbort = mock(() =>
      Promise.reject(new Error("Couldn't stop. Try again.")),
    );
    render(<ChatInput onSend={() => {}} onAbort={onAbort} busy />);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't stop. Try again.");
    expect(
      (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  describe("mention autocomplete", () => {
    const MEMBERS = [
      { id: "1", name: "Jane Doe" },
      { id: "2", name: "Bob Smith" },
    ];

    it("opens a filtered dropdown after typing @ and a query", async () => {
      const user = userEvent.setup();
      render(<ChatInput onSend={() => {}} mentionCandidates={MEMBERS} />);
      await user.type(screen.getByLabelText("Message"), "hey @jan");
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(screen.getByRole("option", { name: "Jane Doe" })).toBeTruthy();
      expect(screen.queryByRole("option", { name: "Bob Smith" })).toBeNull();
    });

    it("inserts the wire-format token on Enter and closes the dropdown", async () => {
      const user = userEvent.setup();
      render(<ChatInput onSend={() => {}} mentionCandidates={MEMBERS} />);
      const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
      await user.type(input, "hey @jan{Enter}");
      expect(input.value).toBe("hey @[Jane Doe](#usr_1) ");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("navigates candidates with arrow keys before inserting", async () => {
      const user = userEvent.setup();
      render(<ChatInput onSend={() => {}} mentionCandidates={MEMBERS} />);
      const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
      await user.type(input, "@");
      await user.keyboard("{ArrowDown}{Enter}");
      expect(input.value).toBe("@[Bob Smith](#usr_2) ");
    });

    it("closes the dropdown on Escape without inserting a token", async () => {
      const user = userEvent.setup();
      render(<ChatInput onSend={() => {}} mentionCandidates={MEMBERS} />);
      const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
      await user.type(input, "hey @jan{Escape}");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(input.value).toBe("hey @jan");
    });

    it("does not open a dropdown when no mention candidates are given", async () => {
      const user = userEvent.setup();
      render(<ChatInput onSend={() => {}} />);
      await user.type(screen.getByLabelText("Message"), "hey @jan");
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});

describe("ChatInput voice dictation", () => {
  let lastRecognition: {
    onresult: ((event: unknown) => void) | null;
    onspeechend: (() => void) | null;
    start: () => void;
  } | null = null;

  class WindowSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "en-US";
    onresult: ((event: unknown) => void) | null = null;
    onspeechend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      lastRecognition = this;
    }
    stop() {}
    abort() {}
  }

  beforeEach(() => {
    lastRecognition = null;
    (
      window as Window & { SpeechRecognition?: typeof WindowSpeechRecognition }
    ).SpeechRecognition = WindowSpeechRecognition;
  });

  it("shows the mic control only when voiceInput is enabled", () => {
    render(<ChatInput onSend={() => {}} />);
    expect(screen.queryByRole("button", { name: "Start voice input" })).toBeNull();

    render(<ChatInput onSend={() => {}} voiceInput />);
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeDefined();
  });

  it("writes transcripts into the message field and auto-sends after silence", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatInput onSend={onSend} voiceInput />);

    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    expect(screen.getByTestId("composer-voice-status").textContent).toContain(
      "Listening",
    );

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    lastRecognition?.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, 0: { transcript: "hello myra" } },
      },
    });
    expect(input.value).toBe("hello myra");

    lastRecognition?.onspeechend?.();
    expect(screen.getByTestId("composer-voice-status").textContent).toContain(
      "Sending in 3",
    );

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });
    expect(onSend.mock.calls[0]?.[0]).toBe("hello myra");
    expect(input.value).toBe("");
    expect(
      screen.getByRole("button", { name: "Stop voice input" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });
});
