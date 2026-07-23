import { describe, expect, it } from "bun:test";
import { toolManifestFile } from "./tool-manifest";

describe("granola tool manifest", () => {
  it("declares the hub-backed call tools with the write side effect", () => {
    const callFactory = toolManifestFile.factories.find(
      (factory) => factory.factoryId === "@workbench/tools-granola/call",
    );
    if (callFactory === undefined) {
      throw new Error("expected @workbench/tools-granola/call factory");
    }
    expect(callFactory.bareToolNames).toContain("granola_create_tasks");
    expect(callFactory.bareToolNames).toContain("granola_fanout_call");
    expect(callFactory.sideEffects.granola_create_tasks).toBe("write");
    expect(callFactory.sideEffects.granola_fanout_call).toBe("write");
  });
});
