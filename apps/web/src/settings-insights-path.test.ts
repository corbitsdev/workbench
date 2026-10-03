import { describe, expect, test } from "bun:test";

import { parseInsightsPath } from "./insights-path";
import { SETTINGS_INSIGHTS_PATH } from "./settings-insights-path";
import type { TenancyAccess } from "./settings/access";

describe("settings-hosted insights path", () => {
  test("renders the runs history inline instead of landing-redirecting away", () => {
    expect(parseInsightsPath(SETTINGS_INSIGHTS_PATH).mode).toBe("runs");
  });

  test("the settings URL itself is an insights landing page, so the dialog must never hand it to the route", () => {
    expect(parseInsightsPath("/settings/insights").mode).toBe("landing");
  });

  test("the embedded insights section gets an explicit non-landing path, never the host URL fallback", async () => {
    // The section's module chain reads `window.location` at import time, and
    // bun's runner has no DOM — stub just enough of it to evaluate, then
    // inspect the returned element's props instead of mounting.
    Object.assign(globalThis, {
      window: {
        location: { pathname: "/settings/insights" },
        history: { replaceState: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    const { resolveAppSettingsSectionGroups } = await import("./settings-groups");
    const access: TenancyAccess = {
      people: "allowed",
      roles: "allowed",
      grants: "allowed",
      credentials: "allowed",
    };
    const sections = resolveAppSettingsSectionGroups(access).flatMap((group) => group.sections);
    const insights = sections.find((section) => section.id === "insights");
    if (insights === undefined) throw new Error("insights section missing from settings groups");
    const { path, embedded } = insights.render({ tenantId: null, principalId: null }).props as {
      readonly path?: unknown;
      readonly embedded?: unknown;
    };
    if (typeof path !== "string") {
      throw new Error("insights section must hand the embedded route an explicit path");
    }
    expect(parseInsightsPath(path).mode).not.toBe("landing");
    // The embedded route must suppress its full-page chrome (crumb links,
    // run-row top-level navigation, sidebar toggle), or clicking any of them
    // navigates the host app out from under the dialog.
    expect(embedded).toBe(true);
  });
});
