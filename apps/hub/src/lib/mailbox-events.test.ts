/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { createMailboxEventBus, MailboxEventSchema } from "./mailbox-events";
import { type } from "arktype";

describe("createMailboxEventBus", () => {
  it("routes a published event to a subscriber for the same principal", () => {
    const bus = createMailboxEventBus();
    const received: unknown[] = [];
    bus.subscribe("prn-a", (e) => received.push(e));

    bus.publish("prn-a", { type: "mailbox", id: "row-1" });

    expect(received).toEqual([{ type: "mailbox", id: "row-1" }]);
  });

  it("does not deliver an event to a subscriber for a different principal", () => {
    const bus = createMailboxEventBus();
    const received: unknown[] = [];
    bus.subscribe("prn-b", (e) => received.push(e));

    bus.publish("prn-a", { type: "mailbox", id: "row-1" });

    expect(received).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = createMailboxEventBus();
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe("prn-a", (e) => received.push(e));

    unsubscribe();
    bus.publish("prn-a", { type: "mailbox", id: "row-1" });

    expect(received).toEqual([]);
  });

  it("fans out to every open connection for the same principal", () => {
    const bus = createMailboxEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe("prn-a", () => (a += 1));
    bus.subscribe("prn-a", () => (b += 1));

    bus.publish("prn-a", { type: "mailbox", id: "row-1" });

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("unsubscribing one connection leaves the other connections for that principal receiving events", () => {
    const bus = createMailboxEventBus();
    let a = 0;
    let b = 0;
    const unsubscribeA = bus.subscribe("prn-a", () => (a += 1));
    bus.subscribe("prn-a", () => (b += 1));

    unsubscribeA();
    bus.publish("prn-a", { type: "mailbox", id: "row-1" });

    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it("exposes an arktype schema that rejects an unknown type", () => {
    const bad = MailboxEventSchema({ type: "bogus", id: "row-1" });
    expect(bad instanceof type.errors).toBe(true);
  });
});
