// WORKBENCH-LOCAL (CL-3880): heal JSON-serialized `toolFactories`.
//
// `AgentDefinition.toolFactories` are functions with `id`/`requires`
// properties attached. Both upstream write points serialize the
// definition raw (`sendMultiStepDeployFrame` puts `steps` on the deploy
// frame verbatim; `writeWorkflowRepoTree` JSON.stringifies the whole
// workflow), and JSON.stringify serializes a function element in an
// array as `null`. The materialized `workflow.json` therefore carries
// `"toolFactories": [null, ...]`, the structural envelope schema admits
// it, and upstream's `hashDefinition` -> `projectAgent` dereferences
// `factory.id` on the null at the first `RunStarted` -- killing every
// triggered run before any tool loading. Upstream documents a wire
// projection that "strips closures" down to `{ id, requires }`
// metadata (apps/sidecar/src/step-agent-tools.ts) but no such
// projection exists at the current pin.
//
// The child never invokes these factories -- the tool-capable step
// factory builds the real runner from the step's pins -- so on load we
// replace every unusable entry with an inert `{ id, requires }` stub
// that satisfies `hashDefinition` and any other metadata reader.
// Entries that already carry a string `id` (a future upstream that
// serializes the projection properly) pass through untouched, so the
// definition hash stays stable across that upstream fix.

type SerializedToolFactoryStub = {
  readonly id: string;
  readonly requires: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stubFor(entry: unknown, index: number): SerializedToolFactoryStub {
  if (isRecord(entry) && typeof entry["id"] === "string") {
    const requires = entry["requires"];
    return {
      id: entry["id"],
      requires:
        Array.isArray(requires) &&
        requires.every((item): item is string => typeof item === "string")
          ? requires
          : [],
    };
  }
  return { id: `serialized-tool-${String(index)}`, requires: [] };
}

function sanitizeAgent(agent: unknown): void {
  if (!isRecord(agent)) return;
  const factories = agent["toolFactories"];
  if (!Array.isArray(factories)) return;
  agent["toolFactories"] = factories.map(stubFor);
}

/**
 * Rewrite every step agent's serialized `toolFactories` in place so the
 * parsed definition is hashable. Walks `step` and `map` primitives and
 * recurses into `loop` bodies, mirroring the shapes `projectPrimitive`
 * visits when `hashDefinition` projects the definition.
 */
export function sanitizeSerializedToolFactories(
  steps: Record<string, unknown>,
): void {
  for (const primitive of Object.values(steps)) {
    if (!isRecord(primitive)) continue;
    if (primitive["kind"] === "step") {
      sanitizeAgent(primitive["agent"]);
    } else if (primitive["kind"] === "map") {
      const step = primitive["step"];
      if (isRecord(step)) sanitizeAgent(step["agent"]);
    } else if (primitive["kind"] === "loop") {
      const body = primitive["body"];
      if (isRecord(body) && isRecord(body["steps"])) {
        sanitizeSerializedToolFactories(body["steps"]);
      }
    }
  }
}
