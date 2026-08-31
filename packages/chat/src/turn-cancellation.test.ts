import { describe, expect, test } from "bun:test";

import {
  createTurnCancelRegistry,
  TurnCancelledError,
} from "./turn-cancellation";

describe("createTurnCancelRegistry (CL-7201)", () => {
  test("cancel aborts every controller registered for that workbench", () => {
    const registry = createTurnCancelRegistry();
    const a = registry.register("wb_1");
    const b = registry.register("wb_1");

    const cancelled = registry.cancel("wb_1");

    expect(cancelled).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(a.signal.reason).toBeInstanceOf(TurnCancelledError);
  });

  test("cancel never touches a controller registered for a different workbench", () => {
    const registry = createTurnCancelRegistry();
    const other = registry.register("wb_2");

    registry.cancel("wb_1");

    expect(other.signal.aborted).toBe(false);
  });

  test("cancel on a workbench with nothing registered is a harmless no-op", () => {
    const registry = createTurnCancelRegistry();
    expect(registry.cancel("wb_never_ran")).toBe(false);
  });

  test("unregister removes a controller so a later cancel no longer reaches it", () => {
    const registry = createTurnCancelRegistry();
    const controller = registry.register("wb_1");
    registry.unregister("wb_1", controller);

    const cancelled = registry.cancel("wb_1");

    expect(cancelled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test("unregistering one of several controllers leaves the rest cancellable", () => {
    const registry = createTurnCancelRegistry();
    const a = registry.register("wb_1");
    const b = registry.register("wb_1");
    registry.unregister("wb_1", a);

    registry.cancel("wb_1");

    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(true);
  });

  test("a second cancel call is a harmless no-op once nothing is left registered", () => {
    const registry = createTurnCancelRegistry();
    const controller = registry.register("wb_1");
    registry.cancel("wb_1");
    registry.unregister("wb_1", controller);

    expect(registry.cancel("wb_1")).toBe(false);
  });
});
