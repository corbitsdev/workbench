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

  it("disables the provider button but keeps its label static while loading", () => {
    render(
      <LoginView state={{ loading: true, error: null }} onOAuth={() => {}} />,
    );
    const button = screen.getByRole("button", {
      name: /continue with google/i,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the submit spinner label only on the email form button while loading", () => {
    render(
      <LoginView
        state={{ loading: true, error: null }}
        onOAuth={() => {}}
        onEmailPassword={() => {}}
      />,
    );
    // Submit button reflects the in-flight state; the provider button keeps its
    // static label so the two never claim to be redirecting at once.
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDefined();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeDefined();
  });

  it("marks the error region as an assertive live alert", () => {
    render(
      <LoginView
        state={{ loading: false, error: "Nope" }}
        onOAuth={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Nope");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
  });

  it("sets autocomplete hints on the email and password inputs", () => {
    render(
      <LoginView state={idle} onOAuth={() => {}} onEmailPassword={() => {}} />,
    );
    const emailInput = screen.getByPlaceholderText("you@company.com");
    const passwordInput = screen.getByPlaceholderText("••••••••");
    expect(emailInput.getAttribute("autocomplete")).toBe("email");
    expect(emailInput.getAttribute("name")).toBe("email");
    expect(passwordInput.getAttribute("autocomplete")).toBe("current-password");
    expect(passwordInput.getAttribute("name")).toBe("password");
  });

  it("renders the welcome heading", () => {
    render(<LoginView state={idle} onOAuth={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /welcome back/i }),
    ).toBeDefined();
  });

  it("submits typed credentials when the email/password form is enabled", () => {
    const onEmailPassword = mock(
      (_creds: { email: string; password: string }) => {},
    );

    render(
      <LoginView
        state={idle}
        onOAuth={() => {}}
        onEmailPassword={onEmailPassword}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "ada@corbits.dev" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(onEmailPassword).toHaveBeenCalledTimes(1);
    expect(onEmailPassword).toHaveBeenCalledWith({
      email: "ada@corbits.dev",
      password: "hunter2",
    });
  });
});
