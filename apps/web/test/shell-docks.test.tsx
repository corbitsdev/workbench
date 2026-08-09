// The rail's bottom identity dock shows the signed-in human as initials
// (never an id, never a network-fetched avatar) with the email as a
// tooltip, and the initials derivation holds up against thin accounts.

import { ThemeProvider } from "@corbits/react-ui";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { NavigationProvider } from "../src/navigation";
import { RailIdentity, initialsOf } from "../src/shell/docks";

const noNavigate = () => undefined;
const noop = () => undefined;

function renderDock(path: string): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <NavigationProvider navigate={noNavigate}>
        <RailIdentity
          path={path}
          user={{
            id: "user_1",
            name: "Ada Lovelace",
            email: "ada@example.com",
          }}
          onSignOut={noop}
        />
      </NavigationProvider>
    </ThemeProvider>,
  );
}

describe("initialsOf", () => {
  test("takes the first letters of the account name", () => {
    expect(initialsOf("Ada Lovelace", "ada@example.com")).toBe("AL");
  });

  test("falls back to the email local part when the name is blank", () => {
    expect(initialsOf("", "grace.hopper@example.com")).toBe("GH");
    expect(initialsOf("  ", "ada@example.com")).toBe("A");
  });

  test("never yields an empty avatar", () => {
    expect(initialsOf("", "@example.com")).toBe("··");
  });
});

describe("RailIdentity", () => {
  test("shows the avatar initials, the email, settings, and theme toggle", () => {
    const markup = renderDock("/");
    expect(markup).toContain("AL");
    expect(markup).toContain("ada@example.com");
    expect(markup).toContain('href="/settings"');
    expect(markup).toContain("Sign out");
    expect(markup).toContain("System theme");
    expect(markup).not.toContain("user_1");
  });

  test("marks settings current when the settings page is open", () => {
    expect(renderDock("/settings")).toContain('aria-current="page"');
    expect(renderDock("/")).not.toContain('aria-current="page"');
  });
});
