import { describe, expect, test } from "bun:test";

import { createInMemoryDraftStore, nextDraftStatus } from "./drafts";

describe("nextDraftStatus", () => {
  test("draft → reviewed → approved", () => {
    expect(nextDraftStatus("draft", "review")).toBe("reviewed");
    expect(nextDraftStatus("reviewed", "approve")).toBe("approved");
  });

  test("cannot approve before review", () => {
    expect(() => nextDraftStatus("draft", "approve")).toThrow();
  });

  test("discard from draft or reviewed", () => {
    expect(nextDraftStatus("draft", "discard")).toBe("discarded");
    expect(nextDraftStatus("reviewed", "discard")).toBe("discarded");
  });

  test("cannot discard approved", () => {
    expect(() => nextDraftStatus("approved", "discard")).toThrow();
  });
});

describe("in-memory draft store", () => {
  test("create → review → approve", async () => {
    const store = createInMemoryDraftStore();
    const draft = await store.createDraft({
      tenantId: "t1",
      prompt: "Summarize Acme Co workbench daily",
      deliveryWorkbenchId: "ch_1",
      scope: "bench",
      createdBy: "user_1",
    });
    expect(draft.status).toBe("draft");

    const reviewed = await store.markReviewed("t1", draft.id, {
      proposedSteps: [{ title: "Collect messages" }, { title: "Write digest" }],
      proposedName: "Daily digest",
      definitionId: "def_digest",
      proposedTrigger: null,
    });
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.proposedSteps).toHaveLength(2);

    const approved = await store.markApproved("t1", draft.id, "rtn_1");
    expect(approved.status).toBe("approved");
    expect(approved.approvedRoutineId).toBe("rtn_1");
  });
});
