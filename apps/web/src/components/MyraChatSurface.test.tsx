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
}));

const { MyraChatSurface } = require("./MyraChatSurface");

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
    expect(screen.getByTestId("disabled")).toBeDefined();
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
    expect(sendSpy).toHaveBeenCalledWith("hello");
  });
});
