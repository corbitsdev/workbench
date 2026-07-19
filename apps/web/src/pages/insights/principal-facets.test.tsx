/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { TimelineEntry } from "@workbench/client";
import { GrantsFacet } from "./principal-facets";
import { MomentDecomposition } from "./MomentWalker";
import { GRANT_EFFECT_LABEL, grantEffect } from "./trace-links";

function grant(summary: string, id = "g1"): TimelineEntry {
  return {
    id,
    kind: "grant",
    sourceTable: "grant",
    timestamp: "2026-07-01T00:00:00.000Z",
    summary,
  } as TimelineEntry;
}

afterEach(() => cleanup());

describe("GrantsFacet effect parity with the moment decomposition", () => {
  // The divergence this pins: a grant whose action token is empty
  // (`<resource> <effect>`) used to read "Allowed" in the timeline decomposition
  // but "Effect not recorded" in the Grants facet, because the facet hand-rolled
  // its own parse. Both now read through the canonical grantEffect().
  it("renders the SAME effect label in the Grants facet and the moment decomposition", () => {
    const g = grant("workbench:* allow");
    const expected = GRANT_EFFECT_LABEL[grantEffect(g)];
    expect(expected).toBe("Allowed");

    const facet = render(
      <MemoryRouter>
        <GrantsFacet entries={[g]} />
      </MemoryRouter>,
    );
    // The row starts inside a collapsed group; expand it to reach the raw rule.
    fireEvent.click(screen.getByRole("button", { name: /Workbench/ }));
    within(facet.container).getByText(expected);
    expect(
      within(facet.container).queryByText("Effect not recorded"),
    ).toBeNull();
    cleanup();

    const moment = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MomentDecomposition
            entry={g}
            previous={undefined}
            tenantId="tenant-1"
            principalId="prn_1"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    within(moment.container).getByText(expected);
    expect(
      within(moment.container).queryByText("Effect not recorded"),
    ).toBeNull();
  });
});

describe("GrantsFacet Granted by column", () => {
  it("surfaces the grant origin as a chip when the summary carries it", () => {
    render(
      <MemoryRouter>
        <GrantsFacet
          entries={[grant("tool:attio__list_objects invoke invoker allow")]}
        />
      </MemoryRouter>,
    );
    screen.getByText("Granted by");
    fireEvent.click(screen.getByRole("button", { name: /Attio/ }));
    const chip = screen.getByTestId("grant-origin");
    expect(chip.textContent).toBe("invoker");
  });

  it("shows a neutral dash when origin is not recorded (legacy 3-token row)", () => {
    render(
      <MemoryRouter>
        <GrantsFacet
          entries={[grant("tool:attio__list_objects invoke allow")]}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Attio/ }));
    expect(screen.queryByTestId("grant-origin")).toBeNull();
  });
});

describe("GrantsFacet grouped rules (CL-3919)", () => {
  it("groups N tool grants from the same package into ONE row with count N, collapsed by default", () => {
    const entries = [
      grant("tool:attio__list_objects invoke allow", "g1"),
      grant("tool:attio__create_object invoke allow", "g2"),
      grant("tool:attio__update_object invoke allow", "g3"),
    ];

    render(
      <MemoryRouter>
        <GrantsFacet entries={entries} />
      </MemoryRouter>,
    );

    // One collapsed group row for the whole "attio" family, not three raw rows.
    expect(screen.getAllByTestId("grant-group-row")).toHaveLength(1);
    screen.getByText("Attio");
    screen.getByText("3 rules");

    // Collapsed: none of the individual rule labels are in the DOM yet.
    expect(screen.queryByText("List objects")).toBeNull();
    expect(screen.queryByText("Create object")).toBeNull();
    expect(screen.queryByText("Update object")).toBeNull();
  });

  it("expands a group in place to reveal the raw rules table exactly as before", () => {
    const entries = [
      grant("tool:attio__list_objects invoke allow", "g1"),
      grant("tool:attio__create_object invoke allow", "g2"),
    ];

    render(
      <MemoryRouter>
        <GrantsFacet entries={entries} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Attio/ }));

    screen.getByText("List objects");
    screen.getByText("Create object");
  });

  it("never hides a deny rule inside a collapsed allow group — surfaces a visible deny marker", () => {
    const entries = [
      grant("tool:attio__list_objects invoke allow", "g1"),
      grant("tool:attio__delete_object invoke deny", "g2"),
    ];

    render(
      <MemoryRouter>
        <GrantsFacet entries={entries} />
      </MemoryRouter>,
    );

    // Deny marker visible on the collapsed group row itself.
    screen.getByTestId("grant-group-deny-marker");
  });

  it("lists deny rules FIRST when a mixed-effect group is expanded", () => {
    const entries = [
      grant("tool:attio__list_objects invoke allow", "g1"),
      grant("tool:attio__delete_object invoke deny", "g2"),
      grant("tool:attio__create_object invoke allow", "g3"),
    ];

    render(
      <MemoryRouter>
        <GrantsFacet entries={entries} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Attio/ }));

    const rows = screen.getAllByTestId("grant-rule-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText(GRANT_EFFECT_LABEL.blocked)).toBeTruthy();
  });

  it("keeps unrelated resource families as separate groups", () => {
    const entries = [
      grant("tool:attio__list_objects invoke allow", "g1"),
      grant("instance:ins_123 invoke allow", "g2"),
    ];

    render(
      <MemoryRouter>
        <GrantsFacet entries={entries} />
      </MemoryRouter>,
    );

    expect(screen.getAllByTestId("grant-group-row")).toHaveLength(2);
  });
});
