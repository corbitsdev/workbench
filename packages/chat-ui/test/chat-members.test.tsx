import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatMembers } from "../src/chat-members";

const realFetch = globalThis.fetch;
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

function mount(overrides: Partial<Parameters<typeof ChatMembers>[0]> = {}) {
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ChatMembers
        tenantId="tnt_1"
        workbenchId="ch_1"
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
        canRemove={true}
        onInvite={() => {}}
        onEditAgent={() => {}}
        onParticipantsChanged={() => {}}
        {...overrides}
      />,
    ),
  );
  click("2 members");
}

function button(label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label,
  );
  if (match === undefined) throw new Error(`Missing button: ${label}`);
  return match;
}
function click(label: string) {
  act(() => button(label).click());
}
function actions() {
  const summary = container.querySelector("summary");
  if (summary === null) throw new Error("Missing member actions");
  act(() => summary.click());
}

test("shows counts, identities, self label, and closes on Escape with focus restored", () => {
  mount();
  expect(container.textContent).toContain("1 person · 1 agent");
  expect(container.textContent).toContain("Alice");
  expect(container.textContent).toContain("You");
  expect(
    container.querySelector('[aria-label="Actions for Alice"]'),
  ).toBeNull();
  actions();
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(container.querySelector("section")).toBeNull();
  expect(document.activeElement).toBe(button("2 members"));
});

test("edits by definition ID and closes before invoking the existing editor", () => {
  let edited = "";
  mount({
    onEditAgent: (id) => {
      edited = id;
    },
  });
  actions();
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
    canRemove: false,
  });
  expect(container.textContent).not.toContain("Remove");
  click("Add member");
  expect(invited).toBe(true);
  expect(container.querySelector("section")).toBeNull();
});

test("does not offer unavailable invite or unresolved agent editing", () => {
  mount({ onInvite: undefined, agents: [], canRemove: false });
  expect(container.textContent).not.toContain("Add member");
  expect(container.querySelector("summary")).toBeNull();
});

test("removal requires confirmation, sends the participant address, and refreshes on success", async () => {
  let removed = "";
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      removed = String(input);
      return Response.json({ address: "myra@agents.example" });
    },
    { preconnect: realFetch.preconnect },
  );
  mount({
    onParticipantsChanged: () => {
      refreshes += 1;
    },
  });
  actions();
  click("Remove");
  expect(removed).toBe("");
  act(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  click("2 members");
  actions();
  expect(button("Remove")).toBeDefined();
  click("Remove");
  await act(async () => {
    button("Click again to remove").click();
  });
  expect(removed).toContain("/participants/myra%40agents.example");
  expect(refreshes).toBe(1);
});

test("failed removal stays recoverable and does not refresh", async () => {
  let refreshes = 0;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json(
        { error: { code: "forbidden", message: "Not allowed" } },
        { status: 403 },
      ),
    { preconnect: realFetch.preconnect },
  );
  mount({
    onParticipantsChanged: () => {
      refreshes += 1;
    },
  });
  actions();
  click("Remove");
  await act(async () => {
    button("Click again to remove").click();
  });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(refreshes).toBe(0);
  expect(button("Remove").disabled).toBe(false);
});
