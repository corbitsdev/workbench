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

type Outcome =
  | { kind: "resolve"; data: unknown }
  | { kind: "reject" }
  | { kind: "pending" };

let offeringsOutcome: Outcome = { kind: "pending" };

function resolveOutcome(outcome: Outcome): Promise<unknown> {
  if (outcome.kind === "resolve") return Promise.resolve(outcome.data);
  if (outcome.kind === "reject") return Promise.reject(new Error("boom"));
  return new Promise(() => {});
}

const setDisabled = mock(
  (_tenantId: string, offeringId: string, disabled: boolean) =>
    Promise.resolve({
      id: offeringId,
      tenantId: "ten_1",
      modelId: "mdl_1",
      providerId: "mpv_1",
      priority: 2,
      disabled,
    }),
);
const deleteOffering = mock((_tenantId: string, _offeringId: string) =>
  Promise.resolve(undefined),
);

mock.module("../../lib/hub-api", () => ({
  getTenantOfferings: () => resolveOutcome(offeringsOutcome),
  setTenantOfferingDisabled: setDisabled,
  deleteTenantOffering: deleteOffering,
}));

import { OwnerOfferings } from "./OwnerOfferings";

function renderOfferings() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OwnerOfferings
        tenantId="ten_1"
        modelNameById={new Map([["mdl_1", "kimi-k3"]])}
        providerNameById={new Map([["mpv_1", "openrouter"]])}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  setDisabled.mockClear();
  deleteOffering.mockClear();
});

describe("OwnerOfferings", () => {
  it("disable click PATCHes the offering to disabled:true", async () => {
    offeringsOutcome = {
      kind: "resolve",
      data: [
        {
          id: "mof_1",
          tenantId: "ten_1",
          modelId: "mdl_1",
          providerId: "mpv_1",
          priority: 2,
          disabled: false,
        },
      ],
    };
    renderOfferings();
    // Resolves ids to names via the passed lookups.
    await waitFor(() => screen.getByText("kimi-k3"));
    // getByText throws if absent — the call itself is the assertion.
    screen.getByText("openrouter");

    fireEvent.click(screen.getByRole("button", { name: /disable/i }));
    await waitFor(() => expect(setDisabled).toHaveBeenCalledTimes(1));
    expect(setDisabled.mock.calls[0]).toEqual(["ten_1", "mof_1", true]);
  });

  it("enable click on a disabled offering PATCHes disabled:false", async () => {
    offeringsOutcome = {
      kind: "resolve",
      data: [
        {
          id: "mof_2",
          tenantId: "ten_1",
          modelId: "mdl_1",
          providerId: "mpv_1",
          priority: 2,
          disabled: true,
        },
      ],
    };
    renderOfferings();
    await waitFor(() => expect(screen.getByText("kimi-k3")));

    fireEvent.click(screen.getByRole("button", { name: /enable/i }));
    await waitFor(() => expect(setDisabled).toHaveBeenCalledTimes(1));
    expect(setDisabled.mock.calls[0]).toEqual(["ten_1", "mof_2", false]);
  });

  it("remove click DELETEs the offering", async () => {
    offeringsOutcome = {
      kind: "resolve",
      data: [
        {
          id: "mof_3",
          tenantId: "ten_1",
          modelId: "mdl_1",
          providerId: "mpv_1",
          priority: 2,
          disabled: false,
        },
      ],
    };
    renderOfferings();
    await waitFor(() => expect(screen.getByText("kimi-k3")));

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(deleteOffering).toHaveBeenCalledTimes(1));
    expect(deleteOffering.mock.calls[0]).toEqual(["ten_1", "mof_3"]);
  });

  it("falls back to the raw ids when a name is not resolvable", async () => {
    offeringsOutcome = {
      kind: "resolve",
      data: [
        {
          id: "mof_4",
          tenantId: "ten_1",
          modelId: "mdl_unknown",
          providerId: "mpv_unknown",
          priority: 0,
          disabled: false,
        },
      ],
    };
    renderOfferings();
    await waitFor(() => screen.getByText("mdl_unknown"));
    screen.getByText("mpv_unknown");
  });

  it("shows an empty state when the tenant owns no offerings", async () => {
    offeringsOutcome = { kind: "resolve", data: [] };
    renderOfferings();
    await waitFor(() => expect(screen.getByText(/owns no offerings yet/i)));
  });

  it("shows a plain-language error, not a raw error, on load failure", async () => {
    offeringsOutcome = { kind: "reject" };
    renderOfferings();
    await waitFor(() => expect(screen.getByText(/could not load offerings/i)));
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});
