/// <reference types="bun" />
import "./test-setup";
import { describe, expect, it } from "bun:test";
import type { RouteObject } from "react-router";
import { router } from "./router";
import { InboxPage } from "./pages/InboxPage";

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
});
