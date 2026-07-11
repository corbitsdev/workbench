/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  createApprovalsEventBus,
  ApprovalEventSchema,
} from "./approvals-events";
import { type } from "arktype";

describe("createApprovalsEventBus", () => {
  it("routes a created event to a subscriber for the same tenant", () => {
    const bus = createApprovalsEventBus();
    const received: unknown[] = [];
    bus.subscribe("tenant-a", (e) => received.push(e));

    bus.publish({ tenantId: "tenant-a", sessionId: "sess-1", kind: "created" });

    expect(received).toEqual([
      { tenantId: "tenant-a", sessionId: "sess-1", kind: "created" },
    ]);
  });

  it("routes a resolved event to a subscriber for the same tenant", () => {
    const bus = createApprovalsEventBus();
    const received: unknown[] = [];
    bus.subscribe("tenant-a", (e) => received.push(e));

    bus.publish({ tenantId: "tenant-a", sessionId: null, kind: "resolved" });

    expect(received).toEqual([
      { tenantId: "tenant-a", sessionId: null, kind: "resolved" },
    ]);
  });

  it("does not deliver an event to a subscriber for a different tenant", () => {
    const bus = createApprovalsEventBus();
    const received: unknown[] = [];
    bus.subscribe("tenant-b", (e) => received.push(e));

    bus.publish({ tenantId: "tenant-a", sessionId: "sess-1", kind: "created" });

    expect(received).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = createApprovalsEventBus();
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe("tenant-a", (e) => received.push(e));

    unsubscribe();
    bus.publish({ tenantId: "tenant-a", sessionId: null, kind: "created" });

    expect(received).toEqual([]);
  });

  it("fans out to every subscriber of the tenant", () => {
    const bus = createApprovalsEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe("tenant-a", () => (a += 1));
    bus.subscribe("tenant-a", () => (b += 1));

    bus.publish({ tenantId: "tenant-a", sessionId: null, kind: "created" });

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("exposes an arktype schema that rejects an unknown kind", () => {
    const bad = ApprovalEventSchema({
      tenantId: "t",
      sessionId: null,
      kind: "bogus",
    });
    expect(bad instanceof type.errors).toBe(true);
  });
});
