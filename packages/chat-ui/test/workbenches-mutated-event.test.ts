import { afterEach, describe, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  WORKBENCHES_MUTATED_EVENT,
  applyStreamWorkbenchesMutated,
  createWorkbench,
} from "../src/api";

if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const workbench = {
  id: "chat-1",
  kind: "chat",
  title: "Myra",
  participants: [],
  pinned: false,
};

describe("createWorkbench mutation event", () => {
  test("a successful create dispatches WORKBENCHES_MUTATED_EVENT with the tenant id", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(workbench), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ tenantId: string }>).detail.tenantId);
    };
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    try {
      await createWorkbench("tnt_1", { kind: "chat", definitionId: "def_1" });
    } finally {
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    }
    expect(seen).toEqual(["tnt_1"]);
  });

  test("a failed create dispatches nothing", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    try {
      await expect(
        createWorkbench("tnt_1", { kind: "chat", definitionId: "def_1" }),
      ).rejects.toThrow();
    } finally {
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    }
    expect(fired).toBe(0);
  });
});

describe("applyStreamWorkbenchesMutated", () => {
  test("valid { tenantId } dispatches WORKBENCHES_MUTATED_EVENT with that tenantId", () => {
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ tenantId: string }>).detail.tenantId);
    };
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    try {
      applyStreamWorkbenchesMutated({ tenantId: "tnt_1" });
    } finally {
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    }
    expect(seen).toEqual(["tnt_1"]);
  });

  test("garbage / missing tenantId does not dispatch", () => {
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    try {
      applyStreamWorkbenchesMutated(undefined);
      applyStreamWorkbenchesMutated(null);
      applyStreamWorkbenchesMutated({});
      applyStreamWorkbenchesMutated({ tenantId: 1 });
      applyStreamWorkbenchesMutated("tnt_1");
    } finally {
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    }
    expect(fired).toBe(0);
  });

  test("extra keys in data still dispatch (forward-compatible)", () => {
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ tenantId: string }>).detail.tenantId);
    };
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    try {
      applyStreamWorkbenchesMutated({ tenantId: "tnt_1", extra: "ok" });
    } finally {
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    }
    expect(seen).toEqual(["tnt_1"]);
  });
});
