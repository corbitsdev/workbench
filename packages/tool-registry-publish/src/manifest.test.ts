import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { ToolSurfaceManifest } from "./manifest";

describe("ToolSurfaceManifest", () => {
  const valid = {
    name: "@corbits/memory-tools",
    version: "0.0.1",
    surface: [
      {
        qualifiedId: "@corbits/memory-tools/memory:memory_add",
        kind: "tool",
        approval: "ask",
      },
      {
        qualifiedId: "@corbits/memory-tools/memory:memory_list",
        kind: "tool",
      },
    ],
  };

  test("accepts a real surface", () => {
    const manifest = ToolSurfaceManifest(valid);
    expect(manifest).not.toBeInstanceOf(type.errors);
    if (!(manifest instanceof type.errors)) {
      expect(manifest.name).toBe("@corbits/memory-tools");
      expect(manifest.surface).toHaveLength(2);
    }
  });

  test("rejects a surface with duplicate qualifiedIds", () => {
    const [first, second] = valid.surface;
    if (first === undefined || second === undefined) throw new Error("fixture");
    const manifest = ToolSurfaceManifest({
      ...valid,
      surface: [first, { ...second, qualifiedId: first.qualifiedId }],
    });
    expect(manifest).toBeInstanceOf(type.errors);
  });

  test("rejects malformed entries", () => {
    expect(
      ToolSurfaceManifest({
        ...valid,
        surface: [{ qualifiedId: "x", kind: "widget" }],
      }),
    ).toBeInstanceOf(type.errors);
    expect(
      ToolSurfaceManifest({ ...valid, surface: [{ kind: "tool" }] }),
    ).toBeInstanceOf(type.errors);
    expect(ToolSurfaceManifest({ ...valid, surface: "nope" })).toBeInstanceOf(
      type.errors,
    );
  });

  test("accepts a skill-kind entry (manifest headroom)", () => {
    const manifest = ToolSurfaceManifest({
      ...valid,
      surface: [{ qualifiedId: "@corbits/skills/s:skills_load", kind: "skill" }],
    });
    expect(manifest).not.toBeInstanceOf(type.errors);
  });
});
