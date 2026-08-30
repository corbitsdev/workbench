import { describe, expect, test } from "bun:test";
import { createInMemoryBlockResponseStore } from "./block-responses";
import type { BlockResponseKey } from "./block-responses";

const KEY: BlockResponseKey = {
  tenantId: "ten_1",
  workbenchId: "run_1",
  messageId: "m1",
  blockId: "blk_question1",
  principalId: "prn_alice",
};

describe("createInMemoryBlockResponseStore — notification claim/release", () => {
  test("claiming before any response is upserted for the key fails", async () => {
    const store = createInMemoryBlockResponseStore();
    await expect(store.claimBlockResponseNotification(KEY)).resolves.toBe(
      false,
    );
  });

  test("the first claim after an upsert wins, returning a token", async () => {
    const store = createInMemoryBlockResponseStore();
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Staging" },
    });
    const token = await store.claimBlockResponseNotification(KEY);
    expect(typeof token).toBe("string");
  });

  test("a second claim for the same key loses while the first is held", async () => {
    const store = createInMemoryBlockResponseStore();
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Staging" },
    });
    await store.claimBlockResponseNotification(KEY);
    await expect(store.claimBlockResponseNotification(KEY)).resolves.toBe(
      false,
    );
  });

  test("release with the holder's own token frees the claim for a fresh claim", async () => {
    const store = createInMemoryBlockResponseStore();
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Staging" },
    });
    const token = await store.claimBlockResponseNotification(KEY);
    await store.releaseBlockResponseNotification(KEY, token as string);
    await expect(store.claimBlockResponseNotification(KEY)).resolves.not.toBe(
      false,
    );
  });

  test("release with a stale token — one a second claim already replaced — never evicts the live claim", async () => {
    const store = createInMemoryBlockResponseStore();
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Staging" },
    });
    const firstToken = await store.claimBlockResponseNotification(KEY);
    expect(firstToken).not.toBe(false);

    // The only way a second claim can exist at all is if the first was
    // already released -- release it "for real" first, then claim again,
    // simulating a delayed release racing a fresh claim.
    await store.releaseBlockResponseNotification(KEY, firstToken as string);
    const secondToken = await store.claimBlockResponseNotification(KEY);
    expect(secondToken).not.toBe(false);
    expect(secondToken).not.toBe(firstToken);

    // A caller presenting the first (now stale) token must never release
    // the second claim it does not hold.
    await store.releaseBlockResponseNotification(KEY, firstToken as string);
    await expect(store.claimBlockResponseNotification(KEY)).resolves.toBe(
      false,
    );
  });

  test("releasing with a token nobody ever held is a harmless no-op", async () => {
    const store = createInMemoryBlockResponseStore();
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Staging" },
    });
    await store.claimBlockResponseNotification(KEY);
    await store.releaseBlockResponseNotification(KEY, "some_other_token");
    // The real claim is still held -- a fresh claim attempt still loses.
    await expect(store.claimBlockResponseNotification(KEY)).resolves.toBe(
      false,
    );
  });

  test("changing the answer keeps the row unclaimable-again once already notified", async () => {
    const store = createInMemoryBlockResponseStore();
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Staging" },
    });
    await store.claimBlockResponseNotification(KEY);

    // A changed answer re-upserts the payload but never clears the claim
    // -- CL-7192's ruling is first-answer-wins, permanently, not just
    // within a race window.
    await store.upsertBlockResponse({
      ...KEY,
      payload: { kind: "question", answer: "Production" },
    });
    await expect(store.claimBlockResponseNotification(KEY)).resolves.toBe(
      false,
    );
  });
});
