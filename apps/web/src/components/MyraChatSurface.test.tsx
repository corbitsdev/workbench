/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { MyraSession } from "../hooks/use-myra-session";

mock.module("@workbench/chat", () => ({
  ChatPanel: (props: {
    messages: unknown[];
    onSend: (t: string) => void;
    notice?: React.ReactNode;
    inputDisabled?: boolean;
    inputAccessory?: React.ReactNode;
    agent: { tagline?: string };
  }) =>
    React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { "data-testid": "tagline" },
        props.agent.tagline ?? "",
      ),
      React.createElement(
        "div",
        { "data-testid": "count" },
        String(props.messages.length),
      ),
      props.notice
        ? React.createElement("div", { "data-testid": "notice" }, props.notice)
        : null,
      props.inputAccessory
        ? React.createElement(
            "div",
            { "data-testid": "accessory" },
            props.inputAccessory,
          )
        : null,
      props.inputDisabled
        ? React.createElement("span", { "data-testid": "disabled" })
        : null,
      React.createElement(
        "button",
        { onClick: () => props.onSend("hello") },
        "send",
      ),
    ),
}));

mock.module("@workbench/agents/browser", () => ({
  friendlyToolSummary: () => "",
  summarizeToolCalls: () => "",
  attachmentPolicyForAgent: () => undefined,
}));

const { MyraChatSurface, ExpandedChatOverlay } = require("./MyraChatSurface");

function makeSession(over: Partial<MyraSession>): MyraSession {
  return {
    state: { phase: "loading" },
    messages: [],
    activity: null,
    send: () => {},
    reconnect: () => {},
    instanceId: null,
    ...over,
  } as MyraSession;
}

afterEach(() => cleanup());

describe("MyraChatSurface", () => {
  it("shows the provisioning notice while setting up", () => {
    render(
      React.createElement(MyraChatSurface, {
        session: makeSession({ state: { phase: "provisioning" } }),
      }),
    );
    expect(screen.getByTestId("notice").textContent).toMatch(/Setting up Myra/);
    screen.getByTestId("disabled");
  });

  it("shows the credential notice when no key resolves", () => {
    render(
      React.createElement(MyraChatSurface, {
        session: makeSession({ state: { phase: "credential-error" } }),
      }),
    );
    expect(screen.getByTestId("notice").textContent).toMatch(
      /No API credential/,
    );
  });

  it("offers a retry that calls reconnect on error", () => {
    let reconnected = 0;
    render(
      React.createElement(MyraChatSurface, {
        session: makeSession({
          state: { phase: "error", message: "x" },
          reconnect: () => reconnected++,
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reconnected).toBe(1);
  });

  it("renders messages and wires send when ready", () => {
    const sendSpy = mock((_t: string) => {});
    const session = makeSession({
      // biome-ignore lint/suspicious/noExplicitAny: minimal ready session for the surface
      state: { phase: "ready", session: {} as any },
      // biome-ignore lint/suspicious/noExplicitAny: opaque chat messages
      messages: [{}, {}] as any,
      send: sendSpy,
    });
    render(
      React.createElement(MyraChatSurface, { session, threadLabel: "Pricing" }),
    );
    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(screen.getByTestId("tagline").textContent).toBe("Pricing");
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(sendSpy.mock.calls[0]?.[0]).toBe("hello");
  });

  function readySession(sendSpy: (t: string) => void): MyraSession {
    return makeSession({
      // biome-ignore lint/suspicious/noExplicitAny: minimal ready session
      state: { phase: "ready", session: {} as any },
      send: sendSpy,
    });
  }

  it("routes free text to the sole pending gate instead of a chat turn (CL-2681)", () => {
    const sendSpy = mock((_t: string) => {});
    const resumeSpy = mock(
      (_runId: string, _signal: string, _text: string) => {},
    );
    render(
      React.createElement(MyraChatSurface, {
        session: readySession(sendSpy),
        signalRouting: {
          mode: "single",
          gate: { runId: "run_1", runKind: "k", signalName: "approve" },
        },
        onResumeSignal: resumeSpy,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(resumeSpy).toHaveBeenCalledWith("run_1", "approve", "hello");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-route free text when more than one gate is pending", () => {
    const sendSpy = mock((_t: string) => {});
    const resumeSpy = mock(
      (_runId: string, _signal: string, _text: string) => {},
    );
    render(
      React.createElement(MyraChatSurface, {
        session: readySession(sendSpy),
        signalRouting: {
          mode: "multi",
          gates: [
            { runId: "run_1", runKind: "k", signalName: "a" },
            { runId: "run_2", runKind: "k", signalName: "b" },
          ],
        },
        onResumeSignal: resumeSpy,
      }),
    );
    // The multi-gate hint tells the user to use a card, and the text is a normal turn.
    expect(screen.getByTestId("accessory").textContent).toMatch(
      /2 runs are waiting/,
    );
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]).toBe("hello");
  });

  function renderExpanded(onExit: () => void) {
    render(
      React.createElement(
        ExpandedChatOverlay,
        { open: true, onExit },
        React.createElement("div", { "data-testid": "child" }, "panel"),
      ),
    );
  }

  it("collapses (not closes) when Escape is pressed while expanded", () => {
    const onExit = mock(() => {});
    renderExpanded(onExit);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("collapses when the visible minimize button is clicked while expanded", () => {
    const onExit = mock(() => {});
    renderExpanded(onExit);
    fireEvent.click(screen.getByRole("button", { name: /minimize/i }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while expanded and restores it on exit", () => {
    const { unmount } = render(
      React.createElement(
        ExpandedChatOverlay,
        { open: true, onExit: () => {} },
        React.createElement("div", null, "panel"),
      ),
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
