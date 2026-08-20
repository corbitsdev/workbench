import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { applyTextDiffToYText, diffText } from "./y-text-diff";

describe("diffText", () => {
  test("a pure append", () => {
    expect(diffText("hello", "hello world")).toEqual({
      index: 5,
      deleteCount: 0,
      insertText: " world",
    });
  });

  test("a pure prepend", () => {
    expect(diffText("world", "hello world")).toEqual({
      index: 0,
      deleteCount: 0,
      insertText: "hello ",
    });
  });

  test("a deletion in the middle", () => {
    expect(diffText("hello brave world", "hello world")).toEqual({
      index: 6,
      deleteCount: 6,
      insertText: "",
    });
  });

  test("a replacement in the middle", () => {
    expect(diffText("hello brave world", "hello cruel world")).toEqual({
      index: 6,
      deleteCount: 5,
      insertText: "cruel",
    });
  });

  test("no change", () => {
    expect(diffText("same", "same")).toEqual({
      index: 4,
      deleteCount: 0,
      insertText: "",
    });
  });

  test("a full replacement (nothing shared)", () => {
    expect(diffText("abc", "xyz")).toEqual({
      index: 0,
      deleteCount: 3,
      insertText: "xyz",
    });
  });

  test("emptying the field entirely", () => {
    expect(diffText("gone", "")).toEqual({
      index: 0,
      deleteCount: 4,
      insertText: "",
    });
  });

  test("typing into an empty field", () => {
    expect(diffText("", "new")).toEqual({
      index: 0,
      deleteCount: 0,
      insertText: "new",
    });
  });

  test("repeated characters don't confuse the prefix/suffix scan", () => {
    // "aaaa" -> "aaaaa": every position matches on both ends, the diff
    // must still land on a single well-formed insert, not double-count
    // the shared run as both prefix and suffix.
    const op = diffText("aaaa", "aaaaa");
    expect(op.deleteCount).toBe(0);
    expect(op.insertText).toBe("a");
    const rebuilt =
      "aaaa".slice(0, op.index) + op.insertText + "aaaa".slice(op.index);
    expect(rebuilt).toBe("aaaaa");
  });
});

describe("applyTextDiffToYText", () => {
  test("applying a diff to a Y.Text produces the target string", () => {
    const doc = new Y.Doc();
    const yText = doc.getText("content");
    yText.insert(0, "hello brave world");

    applyTextDiffToYText(yText, "hello cruel world");

    expect(yText.toString()).toBe("hello cruel world");
  });

  test("two Y.Docs converge after each applies the other's diff-derived update", () => {
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    const aliceText = alice.getText("content");
    const bobText = bob.getText("content");
    aliceText.insert(0, "shared start");
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    applyTextDiffToYText(aliceText, "shared start + alice");
    applyTextDiffToYText(bobText, "bob + shared start");

    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));

    expect(aliceText.toString()).toBe(bobText.toString());
    expect(aliceText.toString()).toContain("alice");
    expect(aliceText.toString()).toContain("bob");
  });

  test("a no-op diff never calls delete/insert", () => {
    const doc = new Y.Doc();
    const yText = doc.getText("content");
    yText.insert(0, "unchanged");
    let changed = false;
    yText.observe(() => {
      changed = true;
    });

    applyTextDiffToYText(yText, "unchanged");

    expect(changed).toBe(false);
  });

  // Promoted from the reviewer's
  // tmp/critique-tests/stale-diff-corruption.test.ts repro (a diff
  // computed against a caller-captured `before` corrupted the doc —
  // "XX hello wo abcrld" — once a remote update mutated `yText` between
  // the caller reading `before` and the diff actually being applied).
  // Inverted here to assert the fix: `applyTextDiffToYText` reads
  // `yText`'s own live content at apply time, so a race can never
  // corrupt it — it always converges exactly to `after`.
  test("a concurrent remote update racing in before apply never corrupts the doc", () => {
    const doc = new Y.Doc();
    const yText = doc.getText("content");
    yText.insert(0, "hello world");

    // What the user intended: append " abc" onto the "hello world" they
    // last saw.
    const localAfter = "hello world abc";

    // A remote peer's update lands on this doc AFTER the user's edit was
    // conceptually formed but BEFORE `applyTextDiffToYText` runs — the
    // exact race a stale `before` baseline can't survive.
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
    remoteDoc.getText("content").insert(0, "XX ");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc), "presence-remote");
    expect(yText.toString()).toBe("XX hello world");

    applyTextDiffToYText(yText, localAfter);

    expect(yText.toString()).toBe(localAfter);
  });

  test("a local edit is applied atomically: an observer never sees a half-applied delete-without-insert", () => {
    const doc = new Y.Doc();
    const yText = doc.getText("content");
    yText.insert(0, "hello brave world");
    const observedStates: string[] = [];
    yText.observe(() => observedStates.push(yText.toString()));

    applyTextDiffToYText(yText, "hello cruel world");

    // Exactly one observed change — delete+insert landed as one
    // transaction, not two separately-observable steps.
    expect(observedStates).toEqual(["hello cruel world"]);
  });
});
