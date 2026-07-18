// The fail-loud backstop for a corrupt loaded tool closure: a null/absent (or
// metadata-less) factory in a package's `factories` array must throw a clear,
// contextual `StepToolFactoryAbsentError` naming the package + address, instead
// of the opaque `null is not an object (evaluating 'factory.id')` NPE the raw
// build loop would throw when it dereferences the factory — which would crash
// the workflow child before it emits `ready`.

import { describe, it, expect } from "bun:test";
import {
  assertLoadedFactory,
  StepToolFactoryAbsentError,
} from "./step-tool-harness";

describe("assertLoadedFactory", () => {
  it("throws a named, contextual error for a null factory", () => {
    let thrown: unknown;
    try {
      assertLoadedFactory(
        null,
        "@workbench/tools-gamma",
        "ins_myra@abklabs.com",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StepToolFactoryAbsentError);
    const e = thrown as StepToolFactoryAbsentError;
    expect(e.packageName).toBe("@workbench/tools-gamma");
    expect(e.address).toBe("ins_myra@abklabs.com");
    expect(e.message).toContain("@workbench/tools-gamma");
    expect(e.message).toContain("ins_myra@abklabs.com");
  });

  it("throws for a factory missing its id/requires metadata", () => {
    // A callable with no `id`/`requires` is not a real loaded factory.
    expect(() =>
      assertLoadedFactory(() => ({}), "@workbench/tools-x", "addr"),
    ).toThrow(StepToolFactoryAbsentError);
    // `requires` present but `id` absent.
    expect(() =>
      assertLoadedFactory(
        Object.assign(() => ({}), { requires: [] }),
        "@workbench/tools-x",
        "addr",
      ),
    ).toThrow(StepToolFactoryAbsentError);
  });

  it("does not throw for a well-formed factory", () => {
    const factory = Object.assign(
      () => ({ definitions: [], run: async () => ({}) }),
      {
        id: "@workbench/tools-gamma/gamma",
        requires: ["GAMMA_API_KEY"],
      },
    );
    expect(() =>
      assertLoadedFactory(factory, "@workbench/tools-gamma", "addr"),
    ).not.toThrow();
  });
});
