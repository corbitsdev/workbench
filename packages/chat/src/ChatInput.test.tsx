/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatInput } from "./ChatInput";

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
});
