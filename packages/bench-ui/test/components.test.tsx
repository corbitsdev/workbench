// Static-markup rendering for the bench surface's pieces, following the
// same convention as packages/chat-ui/test/components.test.tsx: no live
// backing, fixture props in, honest markup out.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { BenchMember, BenchMembership } from "../src/api";
import {
  BenchSwitcher,
  BenchSwitcherList,
  BenchSwitcherTrigger,
} from "../src/bench-switcher";
import { canInviteMember } from "../src/invite-member-dialog";
import { canCreateBench, deriveBenchSlug } from "../src/membership";
import { MemberList } from "../src/member-list";

/** The floor: no rendered text may ever contain a raw identifier. */
const RAW_ID_PATTERN = /\b(prn_|ins_|tnt_|role_|grant_)[a-z0-9]/i;

const noop = () => undefined;

function membership(overrides: Partial<BenchMembership>): BenchMembership {
  return {
    principalId: "prn_1",
    tenantId: "tnt_1",
    tenantName: "Acme",
    tenantSlug: "acme",
    kind: "user",
    status: "active",
    roles: [{ id: "role_1", name: "owner" }],
    ...overrides,
  };
}

function member(overrides: Partial<BenchMember>): BenchMember {
  return {
    id: "prn_1",
    tenantId: "tnt_1",
    kind: "user",
    refId: "user_1",
    displayName: "Ada Lovelace",
    status: "active",
    roles: [{ id: "role_1", name: "member" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("BenchSwitcherTrigger", () => {
  test("shows the active bench name and announces the popover", () => {
    const markup = renderToStaticMarkup(
      <BenchSwitcherTrigger
        activeName="Ada's Bench"
        open={false}
        onToggle={noop}
      />,
    );
    expect(markup).toContain("Ada&#x27;s Bench");
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-expanded="false"');
  });

  test("says so when the account has no benches", () => {
    const markup = renderToStaticMarkup(
      <BenchSwitcherTrigger activeName={null} open={false} onToggle={noop} />,
    );
    expect(markup).toContain("No benches");
  });
});

describe("BenchSwitcherList", () => {
  test("lists bench names as listbox options, never a tenant id", () => {
    const markup = renderToStaticMarkup(
      <BenchSwitcherList
        memberships={[
          membership({ tenantId: "tnt_1", tenantName: "Acme" }),
          membership({ tenantId: "tnt_2", tenantName: "Launch Team" }),
        ]}
        activeTenantId="tnt_1"
        onSelect={noop}
        onCreate={noop}
      />,
    );
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain("Acme");
    expect(markup).toContain("Launch Team");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("marks the active bench selected", () => {
    const markup = renderToStaticMarkup(
      <BenchSwitcherList
        memberships={[membership({ tenantId: "tnt_1" })]}
        activeTenantId="tnt_1"
        onSelect={noop}
        onCreate={noop}
      />,
    );
    expect(markup).toContain('aria-selected="true"');
  });

  test("always offers the create-bench affordance", () => {
    const markup = renderToStaticMarkup(
      <BenchSwitcherList
        memberships={[]}
        activeTenantId={null}
        onSelect={noop}
        onCreate={noop}
      />,
    );
    expect(markup).toContain("+ New workbench");
  });
});

describe("BenchSwitcher", () => {
  test("active trigger name goes through membershipDisplay, never a raw id", () => {
    const markup = renderToStaticMarkup(
      <BenchSwitcher
        memberships={[
          membership({ tenantId: "tnt_1", tenantName: "Acme Labs" }),
        ]}
        activeTenantId="tnt_1"
        onSelect={noop}
        onBenchCreated={noop}
      />,
    );
    expect(markup).toContain("Acme Labs");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });
});

describe("MemberList", () => {
  test("renders a member's name, roles, and status, never a raw id", () => {
    const markup = renderToStaticMarkup(
      <MemberList members={[member({ displayName: "Grace Hopper" })]} />,
    );
    expect(markup).toContain("Grace Hopper");
    expect(markup).toContain("member");
    expect(markup).toContain("active");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("replaces an unresolved agent's raw ref-id fallback with friendly copy", () => {
    const markup = renderToStaticMarkup(
      <MemberList
        members={[
          member({ kind: "agent", displayName: "ins_cd03d8e3", roles: [] }),
        ]}
      />,
    );
    expect(markup).toContain("Unnamed member");
    expect(markup).toContain("none");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("shows the empty state with no members", () => {
    const markup = renderToStaticMarkup(<MemberList members={[]} />);
    expect(markup).toContain("No members yet");
  });
});

// `CreateBenchDialog` and `InviteMemberDialog` render through
// `@corbits/react-ui`'s Radix `Dialog.Portal`, which needs a real DOM
// container and produces no markup under `renderToStaticMarkup` — same
// reason chat-ui's own dialogs have no render test. Their eligibility logic
// is pulled out as pure functions instead and tested directly.
describe("canCreateBench / deriveBenchSlug (the create-bench form)", () => {
  test("a bench needs a name with a derivable slug", () => {
    expect(canCreateBench("")).toBe(false);
    expect(canCreateBench("Acme")).toBe(true);
  });

  test("the slug preview matches what the API client will send", () => {
    expect(deriveBenchSlug("Launch Team")).toBe("launch-team");
  });
});

describe("canInviteMember (the invite-member form)", () => {
  test("requires a plausible email address", () => {
    expect(canInviteMember("")).toBe(false);
    expect(canInviteMember("not-an-email")).toBe(false);
    expect(canInviteMember("person@example.com")).toBe(true);
  });
});

describe("no raw identifiers on screen", () => {
  test("across the whole bench surface's fixture surface — switcher and members", () => {
    const markup = [
      renderToStaticMarkup(
        <BenchSwitcherList
          memberships={[
            membership({ tenantId: "tnt_1", tenantName: "Acme" }),
            membership({
              tenantId: "tnt_2",
              tenantName: "Ada's Bench",
              roles: [],
            }),
          ]}
          activeTenantId="tnt_1"
          onSelect={noop}
          onCreate={noop}
        />,
      ),
      renderToStaticMarkup(
        <MemberList
          members={[
            member({ displayName: "Ada Lovelace" }),
            member({
              id: "prn_2",
              kind: "agent",
              displayName: "ins_unresolved1",
              roles: [],
            }),
          ]}
        />,
      ),
    ].join("\n");

    expect(markup).not.toMatch(RAW_ID_PATTERN);
    expect(markup).toContain("Acme");
    expect(markup).toContain("Ada&#x27;s Bench");
    expect(markup).toContain("Unnamed member");
  });
});
