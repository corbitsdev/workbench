import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatMembers } from "../src/chat-members";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(overrides: Partial<Parameters<typeof ChatMembers>[0]> = {}) {
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ChatMembers
        members={[
          {
            key: "myra@agents.example",
            initials: "",
            label: "Myra",
            tone: "agent",
          },
          { key: "prn_alice", initials: "A", label: "Alice", tone: "neutral" },
        ]}
        agents={[
          {
            address: "myra@agents.example",
            handle: "myra",
            definitionId: "def_myra",
            definitionAssetId: "asset_myra",
            displayName: "Myra",
          },
        ]}
        currentUserPrincipalId="prn_alice"
        onInvite={() => {}}
        onEditAgent={() => {}}
        {...overrides}
      />,
    ),
  );
  click("2 members");
}

function button(label: string) {
  const match = Array.from(document.querySelectorAll("button")).find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label,
  );
  if (match === undefined) throw new Error(`Missing button: ${label}`);
  return match;
}
function click(label: string) {
  const match = Array.from(
    document.querySelectorAll("button, [role='menuitem']"),
  ).find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLElement)) {
    throw new Error(`Missing clickable control: ${label}`);
  }
  act(() => match.click());
}
function actions() {
  act(() =>
    button("Actions for Myra").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    ),
  );
}

test("shows counts, identities, self label, and closes the action menu on Escape", () => {
  mount();
  expect(container.textContent).toContain("1 person · 1 agent");
  expect(container.textContent).toContain("Alice");
  expect(container.textContent).toContain("You");
  expect(
    container.querySelector('[aria-label="Actions for Alice"]'),
  ).toBeNull();
  actions();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(document.querySelector("summary")).toBeNull();
  expect(
    Array.from(document.querySelectorAll('[role="menuitem"]')).some(
      (item) => item.textContent?.trim() === "Remove",
    ),
  ).toBe(false);
  const menu = document.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  act(() =>
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(container.querySelector("section")).not.toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

test("keeps trigger avatars equal and highlights each member row", () => {
  mount();

  const triggerAvatars = Array.from(
    container.querySelectorAll(".member-avatar"),
  );
  expect(triggerAvatars).toHaveLength(2);
  expect(
    triggerAvatars.every((avatar) => avatar.classList.contains("size-6")),
  ).toBe(true);
  const renderedAvatars = Array.from(
    container.querySelectorAll('.chat-member-stack [role="img"]'),
  );
  expect(renderedAvatars).toHaveLength(2);
  expect(
    renderedAvatars.every((avatar) => avatar.classList.contains("size-6")),
  ).toBe(true);

  const memberRows = Array.from(container.querySelectorAll(".chat-member-row"));
  expect(memberRows).toHaveLength(2);
  expect(
    memberRows.every(
      (row) =>
        row.classList.contains("hover:bg-muted") &&
        row.classList.contains("focus-within:bg-muted"),
    ),
  ).toBe(true);
});

test("edits by definition ID and closes before invoking the existing editor", () => {
  let edited = "";
  mount({
    onEditAgent: (id) => {
      edited = id;
    },
  });
  actions();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  click("Edit agent");
  expect(edited).toBe("def_myra");
  expect(container.querySelector("section")).toBeNull();
});

test("opens the existing invite flow and preserves fixed-chat controls", () => {
  let invited = false;
  mount({
    onInvite: () => {
      invited = true;
    },
  });
  expect(container.textContent).not.toContain("Remove");
  click("Add member");
  expect(invited).toBe(true);
  expect(container.querySelector("section")).toBeNull();
});

test("does not offer unavailable invite or unresolved agent editing", () => {
  mount({ onInvite: undefined, agents: [] });
  expect(container.textContent).not.toContain("Add member");
  expect(document.querySelector('[aria-label="Actions for Myra"]')).toBeNull();
});

test("does not offer actions for the native owner", () => {
  mount({
    currentUserPrincipalId: "prn_bob",
    members: [
      {
        key: "myra@agents.example",
        initials: "",
        label: "Myra",
        tone: "agent",
      },
      {
        key: "prn_alice",
        initials: "A",
        label: "Alice",
        tone: "neutral",
      },
    ],
  });
  expect(container.textContent).toContain("Alice");
  expect(document.querySelector('[aria-label="Actions for Alice"]')).toBeNull();
});
