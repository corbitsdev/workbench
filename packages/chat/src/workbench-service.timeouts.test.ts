// CL-7129: the constants a claim's backstop TTL and the CL-6670 wait
// bound are built from have to clear specific arithmetic, not just
// exist — a value that merely narrows the old unbounded wait can still
// undercut `CHAT_TURN_TIMEOUT_MS`, the documented max length a
// legitimate prior turn is allowed to run (see `./turn-claims.test.ts`
// for the store's own TTL-reclaim mechanics; this file is about the
// numbers those mechanics are configured with).
import { describe, expect, test } from "bun:test";

import { CHAT_TURN_TIMEOUT_MS } from "./turn-claims";
import {
  DEFAULT_TURN_DISPATCH_TIMEOUT_MS,
  DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS,
  DEFAULT_TURN_CLAIM_TTL_MS,
} from "./workbench-service";

describe("CL-7129's timeout constants", () => {
  test("the CL-6670 wait bound covers the longest a legitimate prior turn may run", () => {
    // A prior turn is allowed to run the full `CHAT_TURN_TIMEOUT_MS`
    // (the section body's own per-occurrence timeout). A wait bound at
    // or below that would time out a message queued behind such a
    // turn and drop it as undelivered instead of waiting it out.
    expect(DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS).toBeGreaterThan(
      CHAT_TURN_TIMEOUT_MS,
    );
  });

  test("the claim TTL exceeds the wait bound plus the dispatch deadline, so it never fires on a well-behaved dispatch", () => {
    // A well-behaved dispatch spends, in the worst case, the wait bound
    // waiting on a prior turn and then the dispatch deadline making its
    // own call — back to back, inside one claim's lifetime. The TTL has
    // to clear that sum (with margin) to stay an unreachable backstop
    // rather than a bound that reassigns a claim a live dispatch still
    // holds.
    expect(DEFAULT_TURN_CLAIM_TTL_MS).toBeGreaterThan(
      DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS + DEFAULT_TURN_DISPATCH_TIMEOUT_MS,
    );
  });
});
