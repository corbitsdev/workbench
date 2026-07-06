/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { MessageBubble } from "./MessageBubble";
import { type ChatMessage } from "./types";

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

afterEach(() => {
  cleanup();
});

// Let the resolver promise settle and React commit the resulting state; wrapped
// in act so the tests observe the resolved thumbnail / chip without warnings.
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("MessageBubble", () => {
  it("renders user message as plain text", () => {
    const message: ChatMessage = {
      id: "1",
      role: "user",
      content: "Hello agent",
      createdAt: "2026-06-04T00:00:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Hello agent")).not.toBeNull();
  });

  it("renders the user message in a width-constrained orange bubble", () => {
    const message: ChatMessage = {
      id: "u-box",
      role: "user",
      content: "In a bubble",
      createdAt: "2026-06-04T00:00:00Z",
    };
    const { container } = render(<MessageBubble message={message} />);
    const body = container.querySelector(".bg-orange") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toContain("max-w-[80%]");
    expect(body.className).toContain("rounded-lg");
  });

  it("renders the agent message full-width with no surface fill, border, or radius", () => {
    const message: ChatMessage = {
      id: "a-plain",
      role: "agent",
      content: "Plain agent reply",
      createdAt: "2026-06-04T00:01:00Z",
    };
    const { container } = render(<MessageBubble message={message} />);
    const body = container.querySelector(".wb-markdown")
      ?.parentElement as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).not.toContain("bg-surface-2");
    expect(body.className).not.toContain("border");
    expect(body.className).not.toContain("rounded-lg");
    expect(body.className).not.toContain("max-w-[80%]");
    expect(body.className).toContain("w-full");
  });

  it("keeps the system message on its surface treatment", () => {
    const message: ChatMessage = {
      id: "sys-box",
      role: "system",
      content: "System notice",
      createdAt: "2026-06-04T00:02:00Z",
    };
    const { container } = render(<MessageBubble message={message} />);
    const body = container.querySelector(".bg-surface-2") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toContain("italic");
    expect(body.className).toContain("max-w-[80%]");
  });

  it("renders a reasoning disclosure when the agent message carries reasoning", () => {
    const message: ChatMessage = {
      id: "r1",
      role: "agent",
      content: "Final answer",
      reasoning: "I weighed the options",
      createdAt: "2026-06-04T00:01:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Reasoning")).not.toBeNull();
    expect(screen.getByText("Final answer")).not.toBeNull();
  });

  it("shows streaming reasoning collapsed by default with the Reasoning label", () => {
    const message: ChatMessage = {
      id: "r2",
      role: "agent",
      content: "",
      reasoning: "Working through it",
      status: "sending",
      createdAt: "2026-06-04T00:01:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Reasoning")).not.toBeNull();
    expect(screen.queryByText("Working through it")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Reasoning/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("renders agent message with markdown support", () => {
    const message: ChatMessage = {
      id: "2",
      role: "agent",
      content: "# Hello\n\nThis is **bold** text.",
      createdAt: "2026-06-04T00:01:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Hello")).not.toBeNull();
    expect(screen.getByText("bold")).not.toBeNull();
  });

  it("renders system message with markdown support", () => {
    const message: ChatMessage = {
      id: "3",
      role: "system",
      content: "System **notice**",
      createdAt: "2026-06-04T00:02:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("notice")).not.toBeNull();
  });

  it("renders senderLabel when present on an agent-role inbound mail bubble", () => {
    const message: ChatMessage = {
      id: "mail-1",
      role: "agent",
      content: "Please handle this",
      createdAt: "2026-06-05T00:00:00Z",
      senderLabel: "Myra",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("From: Myra")).not.toBeNull();
  });

  it("does not render a sender label when senderLabel is absent", () => {
    const message: ChatMessage = {
      id: "mail-2",
      role: "agent",
      content: "Regular agent message",
      createdAt: "2026-06-05T00:00:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.queryByText(/^From:/)).toBeNull();
  });

  it("shows failed status when present", () => {
    const message: ChatMessage = {
      id: "4",
      role: "user",
      content: "oops",
      createdAt: "2026-06-04T00:03:00Z",
      status: "failed",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Failed to send")).not.toBeNull();
  });

  it("renders an img element for each base64 image in an agent message", () => {
    const message: ChatMessage = {
      id: "img1",
      role: "agent",
      content: "Here is the screenshot",
      createdAt: "2026-06-04T00:04:00Z",
      images: [{ mimeType: "image/png", data: "abc123" }],
    };
    const { container } = render(<MessageBubble message={message} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain("data:image/png;base64,abc123");
  });

  it("renders multiple images when the message has more than one", () => {
    const message: ChatMessage = {
      id: "img2",
      role: "agent",
      content: "Two images",
      createdAt: "2026-06-04T00:05:00Z",
      images: [
        { mimeType: "image/jpeg", data: "data1" },
        { mimeType: "image/png", data: "data2" },
      ],
    };
    const { container } = render(<MessageBubble message={message} />);
    const imgs = Array.from(
      container.querySelectorAll("img"),
    ) as HTMLImageElement[];
    expect(imgs.length).toBe(2);
    const [first, second] = imgs;
    expect(first?.src).toContain("data:image/jpeg;base64,data1");
    expect(second?.src).toContain("data:image/png;base64,data2");
  });

  it("lifts a fenced ui block out of agent prose and renders it via the registry", () => {
    const message: ChatMessage = {
      id: "ui1",
      role: "agent",
      content: [
        "Here is your call.",
        "```ui",
        '{"kind":"choice","prompt":"Which one?","options":[{"id":"a","label":"ABK Demo"}]}',
        "```",
      ].join("\n"),
      createdAt: "2026-06-04T00:07:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Here is your call.")).not.toBeNull();
    expect(screen.getByText("Which one?")).not.toBeNull();
    expect(screen.getByRole("button", { name: "ABK Demo" })).not.toBeNull();
  });

  it("forwards onRespond from an embedded choice block to the caller", async () => {
    const onRespond = mock(() => undefined);
    const user = userEvent.setup();
    const message: ChatMessage = {
      id: "ui2",
      role: "agent",
      content: [
        "```ui",
        '{"kind":"choice","options":[{"id":"a","label":"Yes","value":"yes"}]}',
        "```",
      ].join("\n"),
      createdAt: "2026-06-04T00:08:00Z",
    };
    render(<MessageBubble message={message} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onRespond).toHaveBeenCalledWith({
      blockKind: "choice",
      value: "yes",
    });
  });

  it("stays a safe no-op when a choice is clicked without an onRespond prop", async () => {
    const user = userEvent.setup();
    const message: ChatMessage = {
      id: "ui2b",
      role: "agent",
      content: [
        "```ui",
        '{"kind":"choice","options":[{"id":"a","label":"Yes","value":"yes"}]}',
        "```",
      ].join("\n"),
      createdAt: "2026-06-04T00:08:00Z",
    };
    render(<MessageBubble message={message} />);
    await user.click(screen.getByRole("button", { name: "Yes" }));
    // The block still settles into its answered state; nothing throws.
    expect(screen.getByText(/You chose: Yes/)).not.toBeNull();
  });

  it("does not extract a ui block while the agent message is still streaming", () => {
    const message: ChatMessage = {
      id: "ui3",
      role: "agent",
      status: "sending",
      content: [
        "```ui",
        '{"kind":"choice","options":[{"id":"a","label":"Streamed option"}]}',
        "```",
      ].join("\n"),
      createdAt: "2026-06-04T00:09:00Z",
    };
    render(<MessageBubble message={message} />);
    expect(
      screen.queryByRole("button", { name: "Streamed option" }),
    ).toBeNull();
  });

  it("renders nothing for an empty settled agent message", () => {
    const message: ChatMessage = {
      id: "empty1",
      role: "agent",
      content: "",
      createdAt: "2026-06-04T00:10:00Z",
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a settled agent message that is only whitespace", () => {
    const message: ChatMessage = {
      id: "ws1",
      role: "agent",
      content: "\n\n   \n",
      createdAt: "2026-06-04T00:10:00Z",
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.firstChild).toBeNull();
  });

  it("keys feedback on feedbackId, not the display id, so a rating survives the turn→mail collapse", () => {
    // The bubble's display id is the mail id ("a1"), but the rating was saved
    // against the turn id ("t1") carried on feedbackId. Both the read (getRating)
    // and the write (onRate) must use feedbackId, or the thumb reverts on rebuild.
    const message: ChatMessage = {
      id: "a1",
      feedbackId: "t1",
      role: "agent",
      content: "Same content",
      createdAt: "2026-06-04T00:11:00Z",
    };
    const getRating = mock((subjectId: string) =>
      subjectId === "t1" ? (1 as const) : null,
    );
    const onRate = mock(() => Promise.resolve());

    render(
      <MessageBubble message={message} getRating={getRating} onRate={onRate} />,
    );

    // Saved rating is read under the turn id and shows as pressed.
    const up = screen.getByRole("button", { name: "Thumbs up" });
    expect(up.getAttribute("aria-pressed")).toBe("true");
    expect(getRating).toHaveBeenCalledWith("t1", "turn_part");

    fireEvent.click(screen.getByRole("button", { name: "Thumbs down" }));
    expect(onRate).toHaveBeenCalledWith("t1", "turn_part", -1);
  });

  it("shows a broken-image fallback on load error without crashing", () => {
    const message: ChatMessage = {
      id: "img3",
      role: "agent",
      content: "broken",
      createdAt: "2026-06-04T00:06:00Z",
      images: [{ mimeType: "image/png", data: "badbytes" }],
    };
    const { container } = render(<MessageBubble message={message} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Image unavailable")).not.toBeNull();
  });

  it("renders a downloadable file chip for a document attachment", async () => {
    const resolveAttachmentUrl = mock(async () => "blob:doc");
    const message: ChatMessage = {
      id: "att-doc",
      role: "user",
      content: "See attached",
      createdAt: "2026-06-04T00:07:00Z",
      attachments: [
        {
          blobId: "b1",
          name: "report.pdf",
          type: "application/pdf",
          size: 2048,
        },
      ],
    };
    render(
      <MessageBubble
        message={message}
        resolveAttachmentUrl={resolveAttachmentUrl}
      />,
    );
    expect(screen.getByText("report.pdf")).not.toBeNull();
    expect(screen.getByText("2 KB")).not.toBeNull();
    // A document chip does not eagerly fetch bytes; it fetches on download.
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
  });

  it("surfaces a download error instead of swallowing it when the resolver rejects", async () => {
    const resolveAttachmentUrl = mock(() => Promise.reject(new Error("nope")));
    const message: ChatMessage = {
      id: "att-fail",
      role: "user",
      content: "See attached",
      createdAt: "2026-06-04T00:07:00Z",
      attachments: [
        {
          blobId: "b2",
          name: "report.pdf",
          type: "application/pdf",
          size: 2048,
        },
      ],
    };
    render(
      <MessageBubble
        message={message}
        resolveAttachmentUrl={resolveAttachmentUrl}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /report\.pdf/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't download");
  });

  it("renders an <img> thumbnail for an image attachment via the resolver", async () => {
    const resolveAttachmentUrl = mock(async () => "blob:image-xyz");
    const message: ChatMessage = {
      id: "att-img",
      role: "user",
      content: "pic",
      createdAt: "2026-06-04T00:08:00Z",
      attachments: [
        { blobId: "b2", name: "shot.png", type: "image/png", size: 512 },
      ],
    };
    const { container } = render(
      <MessageBubble
        message={message}
        resolveAttachmentUrl={resolveAttachmentUrl}
      />,
    );
    await flush();
    expect(resolveAttachmentUrl).toHaveBeenCalledWith("b2");
    const img = container.querySelector(
      "img[src='blob:image-xyz']",
    ) as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.alt).toBe("shot.png");
  });

  it("falls back to a file chip when an image attachment fails to resolve", async () => {
    const resolveAttachmentUrl = mock(async () => {
      throw new Error("no bytes");
    });
    const message: ChatMessage = {
      id: "att-img-fail",
      role: "user",
      content: "pic",
      createdAt: "2026-06-04T00:09:00Z",
      attachments: [
        { blobId: "b3", name: "broken.png", type: "image/png", size: 128 },
      ],
    };
    const { container } = render(
      <MessageBubble
        message={message}
        resolveAttachmentUrl={resolveAttachmentUrl}
      />,
    );
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("broken.png")).not.toBeNull();
  });

  it("does not render attachments when no resolver is supplied", () => {
    const message: ChatMessage = {
      id: "att-noresolve",
      role: "user",
      content: "See attached",
      createdAt: "2026-06-04T00:10:00Z",
      attachments: [
        {
          blobId: "b4",
          name: "report.pdf",
          type: "application/pdf",
          size: 2048,
        },
      ],
    };
    render(<MessageBubble message={message} />);
    expect(screen.queryByText("report.pdf")).toBeNull();
  });
});
