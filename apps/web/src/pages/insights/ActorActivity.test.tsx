/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router";

type Actor = {
  id: string;
  kind: "user" | "agent";
  displayName: string;
  email?: string;
  status: string;
};

let searchCalls: { tenantId: string; query: string }[] = [];
let searchResult: Actor[] = [];
let searchError: Error | null = null;

mock.module("@workbench/client", () => ({
  searchActors: (
    _options: unknown,
    params: { tenantId: string; query: string },
  ) => {
    searchCalls.push({ tenantId: params.tenantId, query: params.query });
    if (searchError) return Promise.reject(searchError);
    return Promise.resolve(searchResult);
  },
}));

import { ActorActivitySection, actorHref } from "./ActorActivity";

const USER_ACTOR: Actor = {
  id: "prn_u1",
  kind: "user",
  displayName: "Myra Ops",
  email: "myra@example.com",
  status: "active",
};
const DEACTIVATED_AGENT: Actor = {
  id: "prn_a1",
  kind: "agent",
  displayName: "Oat",
  status: "deactivated",
};

function ActorProbe() {
  const { id } = useParams();
  const location = useLocation();
  return (
    <div data-testid="actor-probe">
      <span data-testid="probe-id">{id}</span>
      <span data-testid="probe-name">
        {(location.state as { displayName?: string } | null)?.displayName ?? ""}
      </span>
    </div>
  );
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/insights"]}>
        <Routes>
          <Route
            path="/insights"
            element={<ActorActivitySection tenantId="tenant-1" />}
          />
          <Route path="/insights/users/:id" element={<ActorProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchFor(query: string, actors: Actor[]) {
  searchResult = actors;
  typeQuery(query);
  await waitFor(() => {
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);
  });
}

beforeEach(() => {
  searchCalls = [];
  searchResult = [];
  searchError = null;
});

afterEach(() => {
  cleanup();
});

describe("actorHref", () => {
  it("builds a deep link to the routed actor page", () => {
    expect(actorHref("prn_u1")).toBe("/insights/users/prn_u1");
  });
});

describe("ActorActivitySection search", () => {
  it("does not fetch for queries under 2 characters", async () => {
    renderSection();
    typeQuery("m");
    await sleep(450);
    expect(searchCalls.length).toBe(0);
    screen.getByText("Type at least 2 characters to search.");
  });

  it("debounces a keystroke burst into a single request for the final query", async () => {
    renderSection();
    typeQuery("my");
    typeQuery("myr");
    typeQuery("myra");
    await sleep(450);
    await waitFor(() => {
      expect(searchCalls.length).toBe(1);
    });
    expect(searchCalls[0]).toEqual({ tenantId: "tenant-1", query: "myra" });
  });

  it("renders results with kind tags and a status chip for non-active actors", async () => {
    renderSection();
    await searchFor("oa", [USER_ACTOR, DEACTIVATED_AGENT]);

    await waitFor(() => {
      screen.getByText("Myra Ops");
    });
    screen.getByText("Oat");
    screen.getByText("myra@example.com");
    screen.getByText("User");
    screen.getByText("Agent");
    const chips = screen.getAllByTestId("actor-status");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe("deactivated");
  });

  it("shows an empty state when nothing matches", async () => {
    renderSection();
    await searchFor("zz", []);
    await waitFor(() => {
      screen.getByText(/No people or agents match/);
    });
  });

  it("shows a plain-language error when search fails", async () => {
    searchError = new Error("HTTP 500");
    renderSection();
    typeQuery("my");
    await waitFor(() => {
      screen.getByText("Search failed. Please try again.");
    });
  });
});

describe("ActorActivitySection navigation", () => {
  it("navigates to the actor's routed page and passes identity via router state", async () => {
    renderSection();
    await searchFor("my", [USER_ACTOR]);
    await waitFor(() => {
      screen.getByText("Myra Ops");
    });

    fireEvent.click(screen.getByText("Myra Ops"));

    await waitFor(() => {
      screen.getByTestId("actor-probe");
    });
    expect(screen.getByTestId("probe-id").textContent).toBe("prn_u1");
    expect(screen.getByTestId("probe-name").textContent).toBe("Myra Ops");
  });
});
