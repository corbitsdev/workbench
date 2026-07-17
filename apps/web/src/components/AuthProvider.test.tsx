/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const sessionUser = {
  id: "user_1",
  email: "sawyer@abklabs.com",
  name: "Sawyer",
  image: null,
};

mock.module("../lib/auth-client", () => ({
  authClient: {
    getSession: async () => ({ data: { user: sessionUser } }),
    signOut: async () => {},
  },
}));

const postMe = mock(async () => ({ userId: "user_1", userName: "Sawyer" }));

mock.module("../lib/hub-api", () => ({
  invalidateMeSyncCache: () => {},
  postMe,
  patchMePreferences: async () => ({}),
}));

const { AuthProvider } = await import("./AuthProvider");

function renderWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <div />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  postMe.mockClear();
});

describe("AuthProvider", () => {
  it("syncs on page load without reconciling grants", async () => {
    renderWithClient();

    await waitFor(() => expect(postMe).toHaveBeenCalled());
    expect(postMe).toHaveBeenCalledWith({ syncPersonalAgent: false });
  });
});
