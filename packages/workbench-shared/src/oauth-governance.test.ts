import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_ACTION,
  capabilityResource,
  CREDENTIAL_PROVIDER_CATALOG,
  findOAuthProviderByAppCredential,
  findOAuthProviderConfig,
  inboxCapabilityPreferenceKey,
  OAUTH_PROVIDER_CATALOG,
  OAuthProviderConfigSchema,
} from "./governance";
import {
  getPreferenceEntry,
  PREFERENCE_DEFAULTS,
} from "./preferences-registry";

describe("capability gate vocabulary (CL-3356 #1)", () => {
  test("capabilityResource namespaces the provider", () => {
    expect(capabilityResource("linear")).toBe("capability:linear");
    expect(capabilityResource("attio")).toBe("capability:attio");
  });

  test("the gate verb is 'use'", () => {
    expect(CAPABILITY_ACTION).toBe("use");
  });
});

describe("OAuth provider catalog (CL-3356 #2)", () => {
  test("every catalog entry matches the schema", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      const parsed = OAuthProviderConfigSchema(entry);
      expect(parsed).toEqual(entry);
    }
  });

  test("Linear needs no refresh; Attio does", () => {
    expect(findOAuthProviderConfig("linear")?.hasRefresh).toBe(false);
    expect(findOAuthProviderConfig("attio")?.hasRefresh).toBe(true);
  });

  test("GitHub is intentionally not in the v1 OAuth-user-token catalog", () => {
    expect(findOAuthProviderConfig("github")).toBeUndefined();
  });

  test("every OAuth provider's app-credential provider is in CREDENTIAL_PROVIDER_CATALOG", () => {
    // A missing entry must fail a test, not surface as a broken Owner UI (the
    // owner sets the app client id/secret on that catalog row). Mirrors the
    // "surfaces every seeded tool credential" seed-credentials test.
    const catalogNames = new Set(
      CREDENTIAL_PROVIDER_CATALOG.map((e) => e.providerName),
    );
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      expect(catalogNames.has(entry.appCredentialProviderName)).toBe(true);
    }
  });

  test("every requested scope has a plain-language description", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      for (const scope of entry.scopes) {
        expect(entry.scopeDescriptions[scope]).toBeDefined();
        expect(entry.scopeDescriptions[scope]!.length).toBeGreaterThan(0);
      }
    }
  });

  test("authorize/token endpoints are absolute URLs", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      expect(() => new URL(entry.authorizationUrl)).not.toThrow();
      expect(() => new URL(entry.tokenUrl)).not.toThrow();
    }
  });
});

describe("guided owner setup metadata (CL-3356 follow-on)", () => {
  test("every provider carries setup metadata with a documented https register URL", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      expect(entry.setup.registerUrl.startsWith("https://")).toBe(true);
      expect(() => new URL(entry.setup.registerUrl)).not.toThrow();
    }
  });

  test("the callback path matches the provider's callback route", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      expect(entry.setup.callbackPath).toBe(
        `/oauth/callback/${entry.providerName}`,
      );
    }
  });

  test("steps are a non-empty ordered list and field hints are present", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      expect(entry.setup.steps.length).toBeGreaterThan(0);
      expect(entry.setup.fieldHints.clientId.length).toBeGreaterThan(0);
      expect(entry.setup.fieldHints.clientSecret.length).toBeGreaterThan(0);
    }
  });

  test("findOAuthProviderByAppCredential maps an app-credential row to its config", () => {
    expect(
      findOAuthProviderByAppCredential("linear-oauth-app")?.providerName,
    ).toBe("linear");
    expect(
      findOAuthProviderByAppCredential("attio-oauth-app")?.providerName,
    ).toBe("attio");
    expect(findOAuthProviderByAppCredential("granola")).toBeUndefined();
  });
});

describe("inbox.capability preference registration", () => {
  test("each connectable provider registers a boolean toggle defaulting on", () => {
    for (const entry of OAUTH_PROVIDER_CATALOG) {
      const key = inboxCapabilityPreferenceKey(entry.providerName);
      const registered = getPreferenceEntry(key);
      expect(registered?.type).toBe("boolean");
      expect(registered?.category).toBe("Inbox");
      expect(PREFERENCE_DEFAULTS[key]).toBe(true);
    }
  });
});
