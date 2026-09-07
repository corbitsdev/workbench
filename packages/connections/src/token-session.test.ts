import { describe, expect, test } from "bun:test";

import {
  createCredentialTokenSession,
  type CredentialTokenRow,
  type RefreshedTokens,
} from "./token-session";

// Times are epoch-ms values far above the 60s default skew lead, so
// "unexpired" and "expiring" rows are unambiguous.
const T0 = 1_000_000_000;
const DEFAULT_EXPIRES_AT = T0 + 10 * 60 * 1000;
const REFRESHED_EXPIRES_AT = T0 + 60 * 60 * 1000;

function row(overrides: Partial<CredentialTokenRow> = {}): CredentialTokenRow {
  return {
    id: "cred_1",
    type: "oauth_token",
    secret: "access-1",
    refreshSecret: "refresh-1",
    expiresAt: new Date(DEFAULT_EXPIRES_AT),
    ...overrides,
  };
}

function deps(
  overrides: {
    loadProfile?: (id: string) => Promise<CredentialTokenRow | null>;
    updateTokens?: (id: string, tokens: RefreshedTokens) => Promise<void>;
    refresh?: (row: CredentialTokenRow) => Promise<RefreshedTokens>;
    now?: () => number;
  } = {},
) {
  let current: CredentialTokenRow | null = row();
  const grantCalls: CredentialTokenRow[] = [];
  const updates: RefreshedTokens[] = [];
  const session = createCredentialTokenSession({
    loadProfile: overrides.loadProfile ?? (async () => current),
    updateTokens: async (id, tokens) => {
      updates.push(tokens);
      current =
        current === null
          ? null
          : {
              ...current,
              secret: tokens.secret,
              refreshSecret: tokens.refreshSecret ?? current.refreshSecret,
              expiresAt: tokens.expiresAt,
            };
      await overrides.updateTokens?.(id, tokens);
    },
    refresh: async (r) => {
      grantCalls.push(r);
      return overrides.refresh
        ? await overrides.refresh(r)
        : { secret: "access-2", expiresAt: new Date(REFRESHED_EXPIRES_AT) };
    },
    now: overrides.now ?? (() => T0),
  });
  return {
    session,
    grantCalls,
    updates,
    setCurrent: (r: CredentialTokenRow | null) => {
      current = r;
    },
  };
}

describe("createCredentialTokenSession", () => {
  test("serves an api_key credential's secret untouched and never refreshes", async () => {
    const d = deps();
    d.setCurrent(
      row({ type: "api_key", refreshSecret: null, expiresAt: null }),
    );
    const result = await d.session.getValidToken("cred_1");
    expect(result).toEqual({ ok: true, secret: "access-1", refreshed: false });
    expect(d.grantCalls).toHaveLength(0);
    expect(d.updates).toHaveLength(0);
  });

  test("serves an unexpired oauth_token without a refresh grant", async () => {
    const d = deps();
    const result = await d.session.getValidToken("cred_1");
    expect(result).toEqual({ ok: true, secret: "access-1", refreshed: false });
    expect(d.grantCalls).toHaveLength(0);
  });

  test("refreshes an expiring oauth_token through the skew lead and persists the new pair", async () => {
    const d = deps({ now: () => T0 + 9 * 60 * 1000 + 59 * 1000 });
    const result = await d.session.getValidToken("cred_1");
    expect(result).toEqual({ ok: true, secret: "access-2", refreshed: true });
    expect(d.grantCalls).toHaveLength(1);
    expect(d.updates).toEqual([
      { secret: "access-2", expiresAt: new Date(REFRESHED_EXPIRES_AT) },
    ]);
  });

  test("coalesces concurrent refreshes into exactly one refresh grant", async () => {
    const loadGate: {
      resolve: (r: CredentialTokenRow) => void;
      promise: Promise<CredentialTokenRow>;
    } = {
      resolve: () => undefined,
      promise: Promise.resolve(row({ expiresAt: new Date(T0 + 1000) })),
    };
    loadGate.promise = new Promise<CredentialTokenRow>((resolve) => {
      loadGate.resolve = resolve;
    });
    const d = deps({
      loadProfile: () => loadGate.promise,
      refresh: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          secret: "access-2",
          refreshSecret: "refresh-2",
          expiresAt: new Date(REFRESHED_EXPIRES_AT),
        };
      },
    });
    loadGate.resolve(row({ expiresAt: new Date(T0 + 1000) }));
    const results = await Promise.all([
      d.session.getValidToken("cred_1"),
      d.session.getValidToken("cred_1"),
      d.session.getValidToken("cred_1"),
      d.session.getValidToken("cred_1"),
      d.session.getValidToken("cred_1"),
    ]);
    for (const result of results) {
      expect(result).toEqual({ ok: true, secret: "access-2", refreshed: true });
    }
    expect(d.grantCalls).toHaveLength(1);
    expect(d.updates).toHaveLength(1);
    expect(d.updates[0]?.refreshSecret).toBe("refresh-2");
  });

  test("each grant call sees the CURRENT persisted row (rotated refresh secret)", async () => {
    // A rotating server: every refresh invalidates the prior refresh
    // token and mints the next one. The grant must therefore receive the
    // row AS PERSISTED NOW, not the row captured when the session was
    // first built — a stale capture sends a dead refresh secret on the
    // second refresh and the provider answers invalid_grant.
    let current: CredentialTokenRow = row();
    let generation = 0;
    const grantRows: CredentialTokenRow[] = [];
    const session = createCredentialTokenSession({
      loadProfile: async () => current,
      updateTokens: async (_id, tokens) => {
        current = {
          ...current,
          secret: tokens.secret,
          refreshSecret: tokens.refreshSecret ?? current.refreshSecret,
          expiresAt: tokens.expiresAt,
        };
      },
      refresh: async (seen) => {
        generation += 1;
        grantRows.push(seen);
        return {
          secret: `rotated-access-${generation}`,
          refreshSecret: `refresh-${generation + 1}`,
          expiresAt: new Date(T0 + generation * 60 * 60 * 1000),
        };
      },
      now: () => T0,
    });

    // First expiry: refreshes against the original pair.
    current = { ...current, expiresAt: new Date(T0 + 1000) };
    const first = await session.getValidToken("cred_1");
    expect(first).toEqual({
      ok: true,
      secret: "rotated-access-1",
      refreshed: true,
    });
    // Second expiry: the stored refresh secret is now "refresh-2"; the
    // second grant call must see exactly that.
    current = { ...current, expiresAt: new Date(T0 + 1000) };
    const second = await session.getValidToken("cred_1");
    expect(second).toEqual({
      ok: true,
      secret: "rotated-access-2",
      refreshed: true,
    });
    expect(grantRows).toHaveLength(2);
    expect(grantRows[1]?.refreshSecret).toBe("refresh-2");
    expect(grantRows[1]?.secret).toBe("rotated-access-1");
  });

  test("reports re-auth-required when the refresh grant fails and persists nothing", async () => {
    const d = deps({
      now: () => T0 + 10 * 60 * 1000 - 1000,
      refresh: async () => {
        throw new Error("refresh_token revoked");
      },
    });
    const result = await d.session.getValidToken("cred_1");
    expect(result).toEqual({
      ok: false,
      reauthRequired: true,
      message: "refresh_token revoked",
    });
    expect(d.updates).toHaveLength(0);
  });

  test("reports re-auth-required for an expired oauth_token with no refresh secret", async () => {
    const d = deps();
    d.setCurrent(row({ refreshSecret: null, expiresAt: new Date(T0 - 1000) }));
    const result = await d.session.getValidToken("cred_1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reauthRequired).toBe(true);
    expect(result.message).toContain("no refresh secret");
    expect(d.grantCalls).toHaveLength(0);
  });

  test("fails closed when the credential row is gone", async () => {
    const d = deps();
    d.setCurrent(null);
    const result = await d.session.getValidToken("cred_1");
    expect(result).toEqual({
      ok: false,
      reauthRequired: false,
      message: "credential cred_1 not found",
    });
  });
});
