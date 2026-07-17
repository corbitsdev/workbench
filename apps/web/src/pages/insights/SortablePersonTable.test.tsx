/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { UsageByPersonRow } from "../../lib/hub-api";
import { SortablePersonTable } from "./SortablePersonTable";

function renderTable(people: UsageByPersonRow[]) {
  return render(
    <MemoryRouter>
      <SortablePersonTable people={people} />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("SortablePersonTable", () => {
  it("shows the hub-computed per-actor dollar cost (CL-2723) alongside turns/tools/tokens", async () => {
    renderTable([
      {
        principalId: "pri_1",
        name: "Sawyer",
        isSelf: true,
        turnCount: 10,
        toolCallCount: 3,
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 7,
        cacheWriteTokens: 8,
        thinkingTokens: 0,
        cost: {
          cost: {
            input: 1.5,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
            total: 1.5,
          },
          unpricedModels: [],
          hasUnpriced: false,
        },
      },
    ]);

    await waitFor(() => screen.getByText("Sawyer"));
    const row = screen.getByText("Sawyer").closest("tr")!;
    expect(row.textContent).toContain("10");
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("$1.50");
  });

  it("shows an explicit not-priced state for a person with no cost computed, never a fabricated $0.00", async () => {
    renderTable([
      {
        principalId: "pri_2",
        name: "Dana",
        isSelf: false,
        turnCount: 1,
        toolCallCount: 0,
        inputTokens: 5,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost: null,
      },
    ]);

    await waitFor(() => screen.getByText("Dana"));
    const row = screen.getByText("Dana").closest("tr")!;
    expect(row.textContent).not.toContain("$");
    expect(row.textContent).toContain("not priced");
  });

  it("shows not-priced (never $0.00) when all of a person's usage is unpriced (CL-2723)", async () => {
    renderTable([
      {
        principalId: "pri_3",
        name: "Robin",
        isSelf: false,
        turnCount: 1,
        toolCallCount: 0,
        inputTokens: 2_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost: {
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
            total: 0,
          },
          unpricedModels: ["(unknown model)"],
          hasUnpriced: true,
        },
      },
    ]);

    await waitFor(() => screen.getByText("Robin"));
    const row = screen.getByText("Robin").closest("tr")!;
    expect(row.textContent).not.toContain("$");
    expect(row.textContent).toContain("not priced");
  });
});
