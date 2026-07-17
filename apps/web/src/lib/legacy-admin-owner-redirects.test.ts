/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  mapLegacyAdminPath,
  mapLegacyOwnerPath,
} from "./legacy-admin-owner-redirects";

describe("mapLegacyAdminPath", () => {
  it("maps the bare /admin index to /settings/admin", () => {
    expect(mapLegacyAdminPath(undefined)).toBe("/settings/admin");
    expect(mapLegacyAdminPath("")).toBe("/settings/admin");
  });

  it("preserves every sub-route tail", () => {
    expect(mapLegacyAdminPath("principals")).toBe("/settings/admin/principals");
    expect(mapLegacyAdminPath("principals/prn_1")).toBe(
      "/settings/admin/principals/prn_1",
    );
    expect(mapLegacyAdminPath("definitions/brief-builder")).toBe(
      "/settings/admin/definitions/brief-builder",
    );
    expect(mapLegacyAdminPath("audit")).toBe("/settings/admin/audit");
    expect(mapLegacyAdminPath("tools/gamma_generate")).toBe(
      "/settings/admin/tools/gamma_generate",
    );
  });
});

describe("mapLegacyOwnerPath", () => {
  it("maps the bare /owner index to /settings/owner", () => {
    expect(mapLegacyOwnerPath(undefined)).toBe("/settings/owner");
    expect(mapLegacyOwnerPath("")).toBe("/settings/owner");
  });

  it("preserves every sub-route tail, including further-nested legacy redirects", () => {
    expect(mapLegacyOwnerPath("catalog")).toBe("/settings/owner/catalog");
    expect(mapLegacyOwnerPath("capabilities/gamma")).toBe(
      "/settings/owner/capabilities/gamma",
    );
    expect(mapLegacyOwnerPath("workflows")).toBe("/settings/owner/workflows");
    expect(mapLegacyOwnerPath("demos")).toBe("/settings/owner/demos");
    expect(mapLegacyOwnerPath("members")).toBe("/settings/owner/members");
    // Legacy sub-redirects (templates/models/setup) resolve a second time
    // against the routes registered under /settings/owner, so the tail is
    // forwarded verbatim rather than pre-resolved here.
    expect(mapLegacyOwnerPath("templates")).toBe("/settings/owner/templates");
  });
});
