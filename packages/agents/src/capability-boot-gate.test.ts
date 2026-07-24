import { describe, expect, it } from "bun:test";
import { FREDDIE_CAPABILITIES } from "./freddie/definition";
import { FANNIE_CAPABILITIES } from "./fannie/definition";
import { HAMMY_CAPABILITIES } from "./hammy-the-humanizer/definition";
import { LINCOLN_CAPABILITIES } from "./lincoln/definition";
import { WALTER_CAPABILITIES } from "./walter/definition";
import { GRANOLA_CAPABILITIES } from "./granola/definition";
import { FIRECRAWL_CAPABILITIES } from "./firecrawl/definition";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_PLATFORM_TOOLS,
} from "@workbench/myra";

/**
 * `canonicalizeAgentCapabilityNames` throws at module-load time, and every
 * capability-bearing agent definition module is imported transitively at hub
 * boot (`apps/hub/src/index.ts` imports `AGENT_TEMPLATES` from
 * `@workbench/agents` at top level, which imports every definition below,
 * plus `@workbench/myra` for Myra's tool lists). A bad capability name that
 * slipped past review is therefore not a failed build — it is a hub
 * crash-loop at boot in production.
 *
 * The static imports above already force every one of these modules to
 * evaluate before any test in this file runs — a bad name throws at
 * collection time, the same failure shape a bad deploy hits at boot. This
 * file exists to make that guarantee explicit and CI-visible, rather than
 * resting on `templates.test.ts` exercising the same chain incidentally
 * through `AGENT_TEMPLATES`.
 */
describe("capability-bearing agent definition modules resolve at import time", () => {
  it("Freddie", () => {
    expect(FREDDIE_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Fannie", () => {
    expect(FANNIE_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Hammy", () => {
    expect(HAMMY_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Lincoln", () => {
    expect(LINCOLN_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Walter", () => {
    expect(WALTER_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Oat (Granola)", () => {
    expect(GRANOLA_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Freddy (Firecrawl)", () => {
    expect(FIRECRAWL_CAPABILITIES.tools.length).toBeGreaterThan(0);
  });

  it("Myra (platform + full grant)", () => {
    expect(PERSONAL_AGENT_PLATFORM_TOOLS.length).toBeGreaterThan(0);
    expect(PERSONAL_AGENT_BASE_TOOLS.length).toBeGreaterThan(
      PERSONAL_AGENT_PLATFORM_TOOLS.length,
    );
  });
});
