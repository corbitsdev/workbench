import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  extractOriginatingWorkbenchId,
  readOriginatingWorkbenchId,
  recordOriginatingWorkbench,
  resolveOriginatingWorkbenchId,
  UNSCOPED_ORIGINATING_WORKBENCH_ID,
} from "./originating-workbench";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

function mailFrom(from: string): Uint8Array {
  return new TextEncoder().encode(
    [`From: ${from}`, "To: myra@alice.localhost", "", "hello"].join("\r\n"),
  );
}

test("extractOriginatingWorkbenchId reads the From local-part", () => {
  expect(extractOriginatingWorkbenchId(mailFrom("chan_room_a@alice.localhost"))).toBe(
    "chan_room_a",
  );
  expect(
    extractOriginatingWorkbenchId(
      mailFrom("Workbench <ins_workbench1@alice.localhost>"),
    ),
  ).toBe("ins_workbench1");
});

test("extractOriginatingWorkbenchId is undefined without a From", () => {
  const raw = new TextEncoder().encode("To: myra@alice.localhost\r\n\r\nhello");
  expect(extractOriginatingWorkbenchId(raw)).toBeUndefined();
});

test("resolveOriginatingWorkbenchId uses the unscoped sentinel when From is missing", () => {
  expect(resolveOriginatingWorkbenchId(undefined)).toBe(
    UNSCOPED_ORIGINATING_WORKBENCH_ID,
  );
  expect(resolveOriginatingWorkbenchId("chan_a")).toBe("chan_a");
});

test("record and read round-trip the originating workbench id", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-wb-"));
  tmpDirs.push(dataDir);
  await recordOriginatingWorkbench({
    dataDir,
    mailboxAddress: "ins_myra@alice.localhost",
    raw: mailFrom("chan_room_b@alice.localhost"),
  });
  expect(
    await readOriginatingWorkbenchId({
      dataDir,
      mailboxAddress: "ins_myra@alice.localhost",
    }),
  ).toBe("chan_room_b");
});

test("a later mail overwrites a stale room id", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-wb-"));
  tmpDirs.push(dataDir);
  const mailboxAddress = "ins_myra@alice.localhost";
  await recordOriginatingWorkbench({
    dataDir,
    mailboxAddress,
    raw: mailFrom("chan_a@alice.localhost"),
  });
  await recordOriginatingWorkbench({
    dataDir,
    mailboxAddress,
    raw: mailFrom("chan_b@alice.localhost"),
  });
  expect(await readOriginatingWorkbenchId({ dataDir, mailboxAddress })).toBe(
    "chan_b",
  );
});

test("unparseable mail records the unscoped sentinel rather than leaving a stale room", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-wb-"));
  tmpDirs.push(dataDir);
  const mailboxAddress = "ins_myra@alice.localhost";
  await recordOriginatingWorkbench({
    dataDir,
    mailboxAddress,
    raw: mailFrom("chan_a@alice.localhost"),
  });
  await recordOriginatingWorkbench({
    dataDir,
    mailboxAddress,
    raw: new TextEncoder().encode("not-a-mail"),
  });
  expect(await readOriginatingWorkbenchId({ dataDir, mailboxAddress })).toBe(
    UNSCOPED_ORIGINATING_WORKBENCH_ID,
  );
});
