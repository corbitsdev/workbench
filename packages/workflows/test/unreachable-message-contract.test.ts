// Contract pin between the two halves of unreachable detection: the
// vendor session service throws a plain Error whose message contains
// "agent is unreachable", and `isAgentUnreachableError` (which the
// one-shot drafting wait and the webhook launch both rely on) sniffs
// exactly that substring. Either side drifting silently disables the
// bounded retry and the typed 422 drafting failure; this scan fails
// loudly instead. The vendor file itself is never modified.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const HELPER_SOURCE = path.join(
  import.meta.dir,
  "../src/deliver-when-routable.ts",
);
const VENDOR_SESSION_SERVICE = path.join(
  import.meta.dir,
  "../../../vendor/intx/hub-sessions/src/session-service.ts",
);

describe("vendor unreachable message contract", () => {
  test("the vendor throw and the substring classifier agree on 'agent is unreachable'", () => {
    const helper = readFileSync(HELPER_SOURCE, "utf8");
    expect(helper).toContain('"agent is unreachable"');

    const vendor = readFileSync(VENDOR_SESSION_SERVICE, "utf8");
    expect(vendor).toContain("agent is unreachable");
  });
});
