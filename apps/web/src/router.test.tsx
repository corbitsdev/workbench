/// <reference types="bun" />
import "./test-setup";
import { describe, expect, it } from "bun:test";
import { matchRoutes, type RouteObject } from "react-router";
import { router } from "./router";
import { InboxPage } from "./pages/InboxPage";
import SettingsLayout from "./pages/SettingsLayout";

function findIndexRoute(routes: RouteObject[]): RouteObject | null {
  for (const route of routes) {
    if (route.index) return route;
    if (route.children) {
      const found = findIndexRoute(route.children);
      if (found) return found;
    }
  }
  return null;
}

describe("router", () => {
  it("lands the index route on the inbox home", () => {
    const index = findIndexRoute(router.routes as RouteObject[]);
    expect(index).not.toBeNull();
    const element = index?.element as React.ReactElement | undefined;
    expect(element?.type).toBe(InboxPage);
  });

  it("keeps the chat surface reachable at its own path", () => {
    const paths: string[] = [];
    const walk = (routes: RouteObject[]) => {
      for (const route of routes) {
        if (route.path) paths.push(route.path);
        if (route.children) walk(route.children);
      }
    };
    walk(router.routes as RouteObject[]);
    expect(paths).toContain("/chats");
    expect(paths).toContain("/chats/:threadId");
  });

  it("mounts the former standalone Admin and Owner areas under the /settings layout", () => {
    const managementPaths = [
      "/settings/admin",
      "/settings/admin/principals",
      "/settings/admin/principals/prn_1",
      "/settings/admin/definitions",
      "/settings/admin/definitions/brief-builder",
      "/settings/admin/audit",
      "/settings/admin/tools",
      "/settings/admin/tools/gamma_generate",
      "/settings/owner",
      "/settings/owner/catalog",
      "/settings/owner/capabilities",
      "/settings/owner/capabilities/gamma",
      "/settings/owner/workflows",
      "/settings/owner/demos",
      "/settings/owner/members",
    ];
    for (const path of managementPaths) {
      const matched = matchRoutes(router.routes, path);
      expect(matched, `no route matches ${path}`).not.toBeNull();
      // Every management path renders inside the Settings layout so the
      // section rail stays mounted (its links keep a reachable active state).
      const elements = (matched ?? []).map(
        (m) => (m.route.element as React.ReactElement | undefined)?.type,
      );
      expect(
        elements,
        `${path} does not render inside SettingsLayout`,
      ).toContain(SettingsLayout);
    }
  });

  it("keeps redirect-only entries for the old standalone /admin and /owner paths", () => {
    const legacyPaths = [
      "/admin",
      "/admin/principals/prn_1",
      "/owner",
      "/owner/capabilities/gamma",
    ];
    for (const path of legacyPaths) {
      const matched = matchRoutes(router.routes, path);
      expect(matched, `no route matches legacy path ${path}`).not.toBeNull();
    }
  });
});
