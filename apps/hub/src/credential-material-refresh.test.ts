import { describe, expect, test } from "bun:test";

import {
  createServingRefresh,
  type ServingRefreshGrantArgs,
  type ServingRefreshStore,
} from "./credential-material-refresh";

// Times sit just outside/inside the 60s skew lead so "not expiring" and
// "expiring now" are unambiguous.
const NOW = 1_000_000_000;
const LATER = NOW + 10 * 60 * 1000;

type Row =
  Parameters<ServingRefreshStore["loadRow"]> extends [string]
    ? Awaited<ReturnType<ServingRefreshStore["loadRow"]>>
    : never;

function store(initial: NonNullable<Row>) {
  let row: NonNullable<Row> | null = initial;
  const calls = {
    refreshedTokens: [] as Awaited<
      ReturnType<ServingRefreshStore["applyRefreshedTokens"]>
    > extends never
      ? never
      : Parameters<ServingRefreshStore["applyRefreshedTokens"]>[1][],
    marked: [] as string[],
    pushes: [] as string[],
    grantArgs: [] as ServingRefreshGrantArgs[],
  };
  const s: ServingRefreshStore = {
    loadRow: async () => row,
    applyRefreshedTokens: async (id, tokens) => {
      calls.refreshedTokens.push(tokens);
      if (row !== null && row.id === id) {
        row = {
          ...row,
          secret: `enc:${tokens.secret}`,
          refreshSecret:
            tokens.refreshSecret === undefined
              ? row.refreshSecret
              : `enc:${tokens.refreshSecret}`,
          expiresAt: tokens.expiresAt,
          status: "active",
        };
      }
      return true;
    },
    markReauthRequired: async (id) => {
      calls.marked.push(id);
      if (row !== null && row.id === id) row = { ...row, status: "error" };
    },
    pushUpdates: async (tenantId) => {
      calls.pushes.push(tenantId);
    },
    decrypt: async (_id, _column, value) => `plain:${value}`,
    loadDueRows: async () => [],
  };
  return { store: s, row: () => row, calls };
}

function row(overrides: Partial<NonNullable<Row>> = {}) {
  return {
    id: "cred_1",
    tenantId: "ten_1",
    type: "oauth_token",
    status: "active",
    secret: "enc:access-1",
    refreshSecret: "enc:refresh-1",
    expiresAt: new Date(LATER),
    providerName: "mcp:example",
    apiBaseUrl: "https://mcp.example",
    metadata: { url: "https://mcp.example" },
    ...overrides,
  } as NonNullable<Row>;
}

function harness(
  initial: NonNullable<Row>,
  grant?: (args: ServingRefreshGrantArgs) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }>,
) {
  const d = store(initial);
  const refresh = createServingRefresh({
    store: d.store,
    hubUrl: "https://hub.example",
    ...(grant === undefined ? {} : { grant }),
    now: () => NOW,
  });
  return { ...d, refresh };
}

describe("createServingRefresh", () => {
  test("an api_key credential passes through untouched — never refreshed, never pushed", async () => {
    const h = harness(
      row({ type: "api_key", refreshSecret: null, expiresAt: null }),
    );
    const result = await h.refresh(servingOf(h));
    expect(result).toEqual({ ok: true });
    expect(h.calls.grantArgs).toHaveLength(0);
    expect(h.calls.refreshedTokens).toHaveLength(0);
    expect(h.calls.pushes).toHaveLength(0);
  });

  test("a well-before-expiry oauth_token is served without a refresh", async () => {
    const h = harness(row());
    const result = await h.refresh(servingOf(h));
    expect(result).toEqual({ ok: true });
    expect(h.calls.refreshedTokens).toHaveLength(0);
    expect(h.calls.pushes).toHaveLength(0);
  });

  test("an expiring oauth_token refreshes, persists, and pushes the updated frame", async () => {
    const h = harness(
      row({ expiresAt: new Date(NOW + 1000) }),
      async (args) => ({
        accessToken: `fresh:${args.refreshToken}`,
        refreshToken: "rotated-refresh",
        expiresIn: 3600,
      }),
    );
    const result = await h.refresh(servingOf(h));
    expect(result).toEqual({ ok: true });
    expect(h.calls.refreshedTokens).toHaveLength(1);
    expect(h.calls.refreshedTokens[0]?.secret).toBe(
      "fresh:plain:enc:refresh-1",
    );
    expect(h.calls.refreshedTokens[0]?.refreshSecret).toBe("rotated-refresh");
    expect(h.calls.pushes).toEqual(["ten_1"]);
  });

  test("a failed refresh marks the credential re-auth-required, pushes, and skips the offering", async () => {
    const h = harness(row({ expiresAt: new Date(NOW + 1000) }), async () => {
      throw new Error("grant rejected");
    });
    const result = await h.refresh(servingOf(h));
    expect(result.ok).toBe(false);
    expect(h.calls.marked).toEqual(["cred_1"]);
    expect(h.row()?.status).toBe("error");
    expect(h.calls.pushes).toEqual(["ten_1"]);
    // The marked credential is never retried: a second serving skips
    // without another doomed grant.
    const second = await h.refresh(servingOf(h, "error"));
    expect(second.ok).toBe(false);
    expect(h.calls.marked).toEqual(["cred_1"]);
  });
});

function servingOf(
  h: ReturnType<typeof harness>,
  status: string = "active",
): Parameters<ReturnType<typeof createServingRefresh>>[0] {
  const current = h.row();
  return {
    id: current?.id ?? "cred_1",
    tenantId: current?.tenantId ?? "ten_1",
    type: current?.type ?? "oauth_token",
    status,
    refreshSecret: current?.refreshSecret ?? null,
    expiresAt: current?.expiresAt ?? null,
  };
}
