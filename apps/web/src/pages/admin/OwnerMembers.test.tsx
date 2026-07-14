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

let members: {
  id: string;
  refId: string;
  displayName: string;
  isOwner: boolean;
}[] = [];
const promoteOwnerMember = mock((_principalId: string) =>
  Promise.resolve({ ok: true }),
);
const demoteOwnerMember = mock((_principalId: string) =>
  Promise.resolve({ ok: true }),
);
mock.module("../../lib/hub-api", () => ({
  getOwnerMembers: () => Promise.resolve({ members }),
  promoteOwnerMember: (id: string) => promoteOwnerMember(id),
  demoteOwnerMember: (id: string) => demoteOwnerMember(id),
}));

import { OwnerMembers } from "./OwnerMembers";

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <OwnerMembers />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  promoteOwnerMember.mockClear();
  demoteOwnerMember.mockClear();
});

describe("OwnerMembers", () => {
  it("renders a role badge for owners and a plain row for members", async () => {
    members = [
      {
        id: "prn_owner",
        refId: "u1",
        displayName: "Ada Lovelace",
        isOwner: true,
      },
      { id: "prn_x", refId: "u2", displayName: "Grace Hopper", isOwner: false },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("Ada Lovelace")));
    expect(screen.getByText("owner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove owner" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make owner" })).toBeTruthy();
  });

  it("promotes a member on click (no confirmation needed)", async () => {
    members = [
      { id: "prn_x", refId: "u2", displayName: "Grace Hopper", isOwner: false },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("Grace Hopper")));
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    await waitFor(() =>
      expect(promoteOwnerMember).toHaveBeenCalledWith("prn_x"),
    );
  });

  it("requires confirmation before demoting an owner", async () => {
    members = [
      {
        id: "prn_owner",
        refId: "u1",
        displayName: "Ada Lovelace",
        isOwner: true,
      },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("Ada Lovelace")));
    fireEvent.click(screen.getByRole("button", { name: "Remove owner" }));
    expect(demoteOwnerMember).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm remove owner" }),
    );
    await waitFor(() =>
      expect(demoteOwnerMember).toHaveBeenCalledWith("prn_owner"),
    );
  });
});
