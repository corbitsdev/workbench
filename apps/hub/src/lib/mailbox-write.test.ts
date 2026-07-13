import { describe, expect, it, mock } from "bun:test";
import { parseHeaderSection } from "@intx/mime";
import type { HubDb } from "../db";
import { buildMailFrame, writeMailboxMessage } from "./mailbox-write";
import { createMailboxEventBus, type MailboxEvent } from "./mailbox-events";

const ARGS = {
  tenantId: "ten-1",
  principalId: "pri-alice",
  address: "usr_alice@tenant.example",
  fromAddress: "myra@tenant.example",
  subject: "Myra triaged: Partnership intro",
  body: "Classification: actionable.\n\nDraft reply below.",
  messageKey: "triage:row-1",
  inReplyTo: "<orig-123@tenant.example>",
};

function makeDb(opts: { returned: { id: string }[] }) {
  const inserted: Record<string, unknown>[] = [];
  const returning = mock(async () => opts.returned);
  const onConflictDoNothing = mock(() => ({ returning }));
  const values = mock((row: Record<string, unknown>) => {
    inserted.push(row);
    return { onConflictDoNothing };
  });
  const db = { insert: mock(() => ({ values })) } as unknown as HubDb;
  return { db, inserted };
}

describe("buildMailFrame", () => {
  it("produces a frame the mime parser round-trips", () => {
    const raw = buildMailFrame({
      from: ARGS.fromAddress,
      to: ARGS.address,
      subject: ARGS.subject,
      inReplyTo: ARGS.inReplyTo,
      body: ARGS.body,
    });
    const { headers, bodyOffset } = parseHeaderSection(raw);
    expect(headers.get("from")).toBe(ARGS.fromAddress);
    expect(headers.get("to")).toBe(ARGS.address);
    expect(headers.get("subject")).toBe(ARGS.subject);
    expect(headers.get("in-reply-to")).toBe(ARGS.inReplyTo);
    expect(headers.get("message-id")).toMatch(/^<.+@tenant\.example>$/);
    expect(headers.get("date")).toBeString();
    const body = new TextDecoder().decode(raw.subarray(bodyOffset)).trim();
    expect(body).toBe("Classification: actionable.\r\n\r\nDraft reply below.");
  });

  it("flattens header newlines so a subject cannot inject headers", () => {
    const raw = buildMailFrame({
      from: ARGS.fromAddress,
      to: ARGS.address,
      subject: "Re: hi\r\nX-Evil: injected",
      body: "b",
    });
    const { headers } = parseHeaderSection(raw);
    expect(headers.get("x-evil")).toBeUndefined();
    expect(headers.get("subject")).toBe("Re: hi X-Evil: injected");
  });

  it("falls back to hub.invalid for the message-id domain when from has no @", () => {
    const raw = buildMailFrame({
      from: "not-an-address",
      to: ARGS.address,
      subject: "s",
      body: "b",
    });
    const { headers } = parseHeaderSection(raw);
    expect(headers.get("message-id")).toMatch(/^<.+@hub\.invalid>$/);
  });

  it("embeds the structured refs as a single-line JSON X-Workbench-Refs header", () => {
    const refs = [
      { kind: "workflow_run" as const, ref: "wfr-1", label: "Open run" },
      { kind: "linear" as const, ref: "https://linear.app/x/ISSUE-1" },
    ];
    const raw = buildMailFrame({
      from: ARGS.fromAddress,
      to: ARGS.address,
      subject: "s",
      body: "b",
      refs,
    });
    const { headers } = parseHeaderSection(raw);
    const header = headers.get("x-workbench-refs");
    expect(header).toBeString();
    expect(header).not.toContain("\n");
    expect(JSON.parse(header as string)).toEqual(refs);
  });

  it("omits the refs header when the refs list is empty", () => {
    const raw = buildMailFrame({
      from: ARGS.fromAddress,
      to: ARGS.address,
      subject: "s",
      body: "b",
      refs: [],
    });
    const { headers } = parseHeaderSection(raw);
    expect(headers.get("x-workbench-refs")).toBeUndefined();
  });

  it("omits in-reply-to when there is no source message id", () => {
    const raw = buildMailFrame({
      from: ARGS.fromAddress,
      to: ARGS.address,
      subject: "s",
      body: "b",
    });
    const { headers } = parseHeaderSection(raw);
    expect(headers.get("in-reply-to")).toBeUndefined();
  });
});

describe("writeMailboxMessage", () => {
  it("inserts an inbound row with the dedupe key and cached headers", async () => {
    const { db, inserted } = makeDb({ returned: [{ id: "row-9" }] });

    const written = await writeMailboxMessage(db, ARGS);

    expect(written).toEqual({ id: "row-9" });
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row).toMatchObject({
      tenantId: "ten-1",
      principalId: "pri-alice",
      address: ARGS.address,
      direction: "inbound",
      subject: ARGS.subject,
      fromAddress: ARGS.fromAddress,
      messageKey: ARGS.messageKey,
    });
    const { headers } = parseHeaderSection(row.raw as Uint8Array);
    expect(headers.get("subject")).toBe(ARGS.subject);
  });

  it("returns null when the dedupe key already exists", async () => {
    const { db } = makeDb({ returned: [] });
    const written = await writeMailboxMessage(db, ARGS);
    expect(written).toBeNull();
  });

  it("publishes a mailbox event to the recipient principal on a successful insert", async () => {
    const { db } = makeDb({ returned: [{ id: "row-9" }] });
    const bus = createMailboxEventBus();
    const received: MailboxEvent[] = [];
    bus.subscribe(ARGS.principalId, (e) => received.push(e));

    await writeMailboxMessage(db, ARGS, bus);

    expect(received).toEqual([{ type: "mailbox", id: "row-9" }]);
  });

  it("does not publish when the dedupe key already exists", async () => {
    const { db } = makeDb({ returned: [] });
    const bus = createMailboxEventBus();
    const received: MailboxEvent[] = [];
    bus.subscribe(ARGS.principalId, (e) => received.push(e));

    await writeMailboxMessage(db, ARGS, bus);

    expect(received).toEqual([]);
  });

  it("does not fail the write when the emitter throws", async () => {
    const { db } = makeDb({ returned: [{ id: "row-9" }] });
    const throwingBus = {
      publish: () => {
        throw new Error("boom");
      },
      subscribe: () => () => {},
    };

    const written = await writeMailboxMessage(db, ARGS, throwingBus);

    expect(written).toEqual({ id: "row-9" });
  });
});
