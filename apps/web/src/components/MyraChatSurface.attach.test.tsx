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

function readySession(send: (text: string) => void): MyraSession {
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
    const resume = mock((_runId: string, _signal: string, _text: string) =>
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
