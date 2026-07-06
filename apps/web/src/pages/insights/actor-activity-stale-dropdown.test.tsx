/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

let searchResult: {
  id: string;
  kind: "user";
  displayName: string;
  status: string;
}[] = [];

mock.module("@workbench/client", () => ({
  searchActors: () => Promise.resolve(searchResult),
  getPrincipalActivity: () =>
    Promise.resolve({ entries: [], nextCursor: null }),
}));

import { ActorActivitySection } from "./ActorActivity";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => cleanup());

describe("clear-input staleness", () => {
  it("dropdown results disappear after the input is cleared", async () => {
    searchResult = [
      { id: "prn_u1", kind: "user", displayName: "Myra Ops", status: "active" },
    ];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ActorActivitySection tenantId="tenant-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "myra" } });
    await waitFor(() => {
      screen.getByText("Myra Ops");
    });

    fireEvent.change(box, { target: { value: "" } });
    await sleep(400); // debounce settled, query disabled
    expect(screen.queryByText("Myra Ops")).toBeNull();
  });
});
