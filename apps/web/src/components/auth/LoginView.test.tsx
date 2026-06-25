/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { LoginView } from "./LoginView";
import type { LoginFormState } from "./types";

afterEach(() => cleanup());

const idle: LoginFormState = { loading: false, error: null };

describe("LoginView", () => {
  it("renders the default Google provider button", () => {
    render(<LoginView state={idle} onOAuth={() => {}} />);
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeDefined();
  });

  it("invokes onOAuth with the provider id when clicked", () => {
    const onOAuth = mock((_provider: string) => {});

    render(<LoginView state={idle} onOAuth={onOAuth} />);
    fireEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    expect(onOAuth).toHaveBeenCalledTimes(1);
    expect(onOAuth).toHaveBeenCalledWith("google");
  });

  it("shows the error message when present", () => {
    render(
      <LoginView
        state={{ loading: false, error: "Nope" }}
        onOAuth={() => {}}
      />,
    );
    expect(screen.getByText("Nope")).toBeDefined();
  });

  it("disables the button and shows redirecting label while loading", () => {
    render(
      <LoginView state={{ loading: true, error: null }} onOAuth={() => {}} />,
    );
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Redirecting…")).toBeDefined();
  });
});
