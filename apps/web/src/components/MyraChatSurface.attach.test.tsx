/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActiveContext } from "@workbench/shared";
import { MyraChatSurface } from "./MyraChatSurface";
import type { MyraSession } from "../hooks/use-myra-session";
import {
  ActiveContextProvider,
  usePublishActiveContext,
} from "../lib/active-context-store";

const ARTIFACT: ActiveContext = {
  kind: "artifact",
  id: "art_99",
  label: "Launch brief",
  artifactKind: "blog",
  body: "The full body the agent should load via the tool.",
};

function readySession(
  send: (text: string, attachments?: unknown) => void,
): MyraSession {
  return {
    state: { phase: "ready", session: {} as never },
    messages: [],
    activity: null,
    send,
    reconnect: () => {},
    instanceId: "i1",
  } as unknown as MyraSession;
}

function Publisher({ ctx }: { ctx: ActiveContext }) {
  usePublishActiveContext(ctx);
  return null;
}

function pressAttach() {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "i",
        metaKey: true,
        cancelable: true,
        bubbles: true,
      }),
    );
  });
}

function makeImageFile(name: string): File {
  return new File([new Uint8Array(64)], name, { type: "image/png" });
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

afterEach(cleanup);

describe("MyraChatSurface active-context attach", () => {
  it("attaches the active surface on Cmd+I and composes its projection into the sent message", () => {
    const send = mock((_text: string) => {});
    render(
      <ActiveContextProvider>
        <Publisher ctx={ARTIFACT} />
        <MyraChatSurface session={readySession(send)} />
      </ActiveContextProvider>,
    );

    expect(screen.queryByText("Launch brief")).toBeNull();

    pressAttach();
    // getByText throws if the pill is absent, so the call is the assertion.
    screen.getByText("Launch brief");

    const input = screen.getByPlaceholderText("Message Myra…");
    fireEvent.change(input, { target: { value: "summarize this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as string;
    expect(sent).toContain("summarize this");
    expect(sent).toContain("art_99");
    expect(sent).toContain("artifact_read");

    // Attachments clear after a send.
    expect(screen.queryByText("Launch brief")).toBeNull();
  });

  it("sends plain text untouched when nothing is attached", () => {
    const send = mock((_text: string) => {});
    render(
      <ActiveContextProvider>
        <Publisher ctx={ARTIFACT} />
        <MyraChatSurface session={readySession(send)} />
      </ActiveContextProvider>,
    );

    const input = screen.getByPlaceholderText("Message Myra…");
    fireEvent.change(input, { target: { value: "just a question" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("just a question");
  });

  it("does NOT route to the gate when active-context pills are attached — composes a normal chat turn instead (CL-2681)", () => {
    const send = mock((_text: string) => {});
    const resume = mock((_runId: string, _signal: string, _payload: unknown) =>
      Promise.resolve(),
    );
    render(
      <ActiveContextProvider>
        <Publisher ctx={ARTIFACT} />
        <MyraChatSurface
          session={readySession(send)}
          signalRouting={{
            mode: "single",
            gate: { runId: "run_1", runKind: "k", signalName: "approve" },
          }}
          onResumeSignal={resume}
        />
      </ActiveContextProvider>,
    );

    pressAttach();
    screen.getByText("Launch brief");

    const input = screen.getByPlaceholderText("Message Myra…");
    fireEvent.change(input, { target: { value: "use this brief" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // A pill is a conversation act, not a gate payload: the text is NOT routed
    // to the gate; it is composed with the pill and sent as a normal turn.
    expect(resume).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as string;
    expect(sent).toContain("use this brief");
    expect(sent).toContain("art_99");
    // The pill is cleared on the normal send path.
    expect(screen.queryByText("Launch brief")).toBeNull();
  });

  it("removes an attached pill via its close button", () => {
    const send = mock((_text: string) => {});
    render(
      <ActiveContextProvider>
        <Publisher ctx={ARTIFACT} />
        <MyraChatSurface session={readySession(send)} />
      </ActiveContextProvider>,
    );

    pressAttach();
    const remove = screen.getByLabelText("Remove Artifact Launch brief");
    fireEvent.click(remove);
    expect(screen.queryByText("Launch brief")).toBeNull();
  });
});

describe("MyraChatSurface clipboard paste (CL-3541)", () => {
  it("attaches a pasted image as a removable chip and sends it with the message", () => {
    const send = mock((_text: string, _attachments?: unknown) => {});
    render(
      <ActiveContextProvider>
        <MyraChatSurface session={readySession(send)} />
      </ActiveContextProvider>,
    );

    const input = screen.getByPlaceholderText(
      "Message Myra…",
    ) as HTMLTextAreaElement;
    pasteFilesOn(input, [makeImageFile("clipboard.png")]);
    expect(screen.getByText("clipboard.png")).toBeDefined();

    fireEvent.change(input, { target: { value: "see this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("see this");
    const attachments = send.mock.calls[0]![1] as
      | { name: string }[]
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.name).toBe("clipboard.png");
    expect(screen.queryByText("clipboard.png")).toBeNull();
  });

  it("still pastes plain text when the clipboard has no files", async () => {
    const user = userEvent.setup();
    const send = mock((_text: string) => {});
    render(
      <ActiveContextProvider>
        <MyraChatSurface session={readySession(send)} />
      </ActiveContextProvider>,
    );

    const input = screen.getByPlaceholderText(
      "Message Myra…",
    ) as HTMLTextAreaElement;
    await user.click(input);
    await user.paste("plain note");
    expect(input.value).toBe("plain note");
    expect(screen.queryByLabelText(/Remove/)).toBeNull();
  });

  it("removes a pasted file chip before send", () => {
    const send = mock((_text: string) => {});
    render(
      <ActiveContextProvider>
        <MyraChatSurface session={readySession(send)} />
      </ActiveContextProvider>,
    );

    const input = screen.getByPlaceholderText(
      "Message Myra…",
    ) as HTMLTextAreaElement;
    pasteFilesOn(input, [makeImageFile("drop-me.png")]);
    fireEvent.click(screen.getByLabelText("Remove drop-me.png"));
    expect(screen.queryByText("drop-me.png")).toBeNull();
  });
});
