/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
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
    expect(screen.queryByTestId("grant-origin")).toBeNull();
  });
});
