/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { matchRoutes } from "react-router";
import { deepLinkKinds, deepLinkPath } from "@workbench/shared";
import { router } from "./router";

// Guards the deepLink helper against the web router: every kind the helper can
// emit MUST resolve to a route the router actually registers. Without this, a
// route rename in router.tsx (or a new deepLink kind) can ship a notification
// whose chip 404s, with nothing failing at compile time — the two are coupled
// by string paths, not types.
describe("deepLink kinds resolve against the web router", () => {
  it.each(deepLinkKinds.map((kind) => [kind]))(
    "kind %s maps to a registered route",
    (kind) => {
      // A sample id; only the path SHAPE matters for matching, not the value.
      const path = deepLinkPath(kind, "sample-id");
      // Strip the query (`task` deep-links carry `?task=`); matchRoutes keys off
      // the pathname.
      const pathname = path.split("?")[0] ?? path;
      const matched = matchRoutes(router.routes, pathname);
      expect(
        matched,
        `no route matches ${kind} path ${pathname}`,
      ).not.toBeNull();
    },
  );
});
