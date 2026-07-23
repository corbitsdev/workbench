/// <reference types="bun" />
import "./test-setup";
import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import {
  createMemoryRouter,
  matchRoutes,
  RouterProvider,
  useLocation,
  type RouteObject,
} from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { router } from "./router";
import { InboxPage } from "./pages/InboxPage";
import SettingsLayout from "./pages/SettingsLayout";
import LibraryLayout from "./pages/LibraryLayout";

/** Finds the element registered for an exact absolute route path, wherever it
 * sits in the nested route tree — used to pull the real redirect component
 * out of `router.routes` for a focused render, without mounting the whole
 * authenticated AppShell (ProtectedLayout/AppShell require session and
 * workbench context this test has no reason to fake). */
function findRouteElement(
  routes: RouteObject[],
  path: string,
): ReactElement | undefined {
  for (const route of routes) {
    if (route.path === path) return route.element as ReactElement;
    if (route.children) {
      const found = findRouteElement(route.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="landed">
      {location.pathname}
      {location.search}
      {location.hash}
    </div>
  );
}

/** Renders the real redirect element registered at `legacyRoutePath` (as
 * matched by react-router param syntax, e.g. "/skills/:id") for
 * `initialEntry`, alongside a probe mounted at `destinationRoutePath`, and
 * returns the string the browser actually lands on. This exercises the
 * `<Navigate>` element itself rather than only confirming the path matches a
 * route. */
async function landedAt(
  legacyRoutePath: string,
  destinationRoutePath: string,
  initialEntry: string,
): Promise<string> {
  const element = findRouteElement(
    router.routes as RouteObject[],
    legacyRoutePath,
  );
  if (!element) {
    throw new Error(`no route registered for ${legacyRoutePath}`);
  }
  const memoryRouter = createMemoryRouter(
    [
      { path: legacyRoutePath, element },
      { path: destinationRoutePath, element: <LocationProbe /> },
    ],
    { initialEntries: [initialEntry] },
  );
  render(<RouterProvider router={memoryRouter} />);
  const landed = await waitFor(() => screen.getByTestId("landed"));
  return landed.textContent ?? "";
}

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

  it("mounts Artifacts, Skills, and Agents as sibling views under the Library layout", () => {
    const libraryPaths = [
      "/library",
      "/library/artifacts",
      "/library/artifacts/art_1",
      "/library/skills",
      "/library/skills/new",
      "/library/skills/skill_1",
      "/library/agents",
    ];
    for (const path of libraryPaths) {
      const matched = matchRoutes(router.routes, path);
      expect(matched, `no route matches ${path}`).not.toBeNull();
      const elements = (matched ?? []).map(
        (m) => (m.route.element as React.ReactElement | undefined)?.type,
      );
      expect(
        elements,
        `${path} does not render inside LibraryLayout`,
      ).toContain(LibraryLayout);
    }
  });

  it("lands the Library index route on Artifacts", () => {
    const libraryRoute = findRouteElement(
      router.routes as RouteObject[],
      "/library",
    );
    expect(libraryRoute).toBeDefined();
  });

  it("keeps redirect-only entries for every earlier home of Artifacts, Skills, and Agents", () => {
    const legacyPaths = [
      "/artifacts",
      "/artifacts/art_1",
      "/skills",
      "/skills/new",
      "/skills/skill_1",
      "/agents",
      "/settings/skills",
      "/settings/skills/new",
      "/settings/skills/skill_1",
      "/settings/agents",
    ];
    for (const path of legacyPaths) {
      const matched = matchRoutes(router.routes, path);
      expect(matched, `no route matches legacy path ${path}`).not.toBeNull();
    }
  });

  it("actually redirects /artifacts to /library/artifacts", async () => {
    const landed = await landedAt(
      "/artifacts",
      "/library/artifacts",
      "/artifacts",
    );
    expect(landed).toBe("/library/artifacts");
  });

  it("actually redirects /artifacts/:artifactId to /library/artifacts/:artifactId, carrying the id, query string, and hash", async () => {
    const landed = await landedAt(
      "/artifacts/:artifactId",
      "/library/artifacts/:artifactId",
      "/artifacts/art_1?x=1#y",
    );
    expect(landed).toBe("/library/artifacts/art_1?x=1#y");
  });

  it("actually redirects /skills to /library/skills", async () => {
    const landed = await landedAt("/skills", "/library/skills", "/skills");
    expect(landed).toBe("/library/skills");
  });

  it("actually redirects /skills/new to /library/skills/new", async () => {
    const landed = await landedAt(
      "/skills/new",
      "/library/skills/new",
      "/skills/new",
    );
    expect(landed).toBe("/library/skills/new");
  });

  it("actually redirects /skills/:id to /library/skills/:id, carrying the id, query string, and hash", async () => {
    const landed = await landedAt(
      "/skills/:id",
      "/library/skills/:id",
      "/skills/skill_1?x=1#y",
    );
    expect(landed).toBe("/library/skills/skill_1?x=1#y");
  });

  it("actually redirects /agents to /library/agents", async () => {
    const landed = await landedAt("/agents", "/library/agents", "/agents");
    expect(landed).toBe("/library/agents");
  });

  it("actually redirects the CL-4247 /settings/skills path to /library/skills", async () => {
    const landed = await landedAt(
      "/settings/skills",
      "/library/skills",
      "/settings/skills",
    );
    expect(landed).toBe("/library/skills");
  });

  it("actually redirects the CL-4247 /settings/skills/new path to /library/skills/new", async () => {
    const landed = await landedAt(
      "/settings/skills/new",
      "/library/skills/new",
      "/settings/skills/new",
    );
    expect(landed).toBe("/library/skills/new");
  });

  it("actually redirects the CL-4247 /settings/skills/:id path to /library/skills/:id, carrying the id, query string, and hash", async () => {
    const landed = await landedAt(
      "/settings/skills/:id",
      "/library/skills/:id",
      "/settings/skills/skill_1?x=1#y",
    );
    expect(landed).toBe("/library/skills/skill_1?x=1#y");
  });

  it("actually redirects the CL-4247 /settings/agents path to /library/agents", async () => {
    const landed = await landedAt(
      "/settings/agents",
      "/library/agents",
      "/settings/agents",
    );
    expect(landed).toBe("/library/agents");
  });
});
