import { describe, expect, test } from "bun:test";

import { hexDecode, hexEncode } from "@intx/types";
import type { WorkflowProbeRequestFrame } from "@intx/types/sidecar";
import { encodeEnvelope, signHmac, type FrameEnvelope } from "@intx/workflow-host";

import {
  createWorkflowProbeExecutor,
  enrichProbeError,
  type MaterializeWorkflowClosure,
  type ProbeChildSpawner,
} from "./workflow-probe-handler";

describe("enrichProbeError", () => {
  test("adds a dependencies/devDependencies hint to a module-not-found", () => {
    const enriched = enrichProbeError(
      new Error("Cannot find module '@wf/lib' from '/x/workflow.mjs'"),
    );
    expect(enriched).toMatch(/could not resolve "@wf\/lib"/);
    expect(enriched).toMatch(/"dependencies" rather than "devDependencies"/);
  });

  test("matches the 'Cannot find package' phrasing too", () => {
    const enriched = enrichProbeError(
      new Error('Cannot find package "left-pad" imported from /x/workflow.mjs'),
    );
    expect(enriched).toMatch(/could not resolve "left-pad"/);
  });

  test("passes a non-resolution error through unchanged", () => {
    const enriched = enrichProbeError(new Error("boom, author code threw"));
    expect(enriched).toBe("boom, author code threw");
  });
});

function probeFrame(): WorkflowProbeRequestFrame {
  return {
    type: "workflow.probe.request",
    requestId: "probe-req-1",
    source: { kind: "registry", registry: "npmjs" },
    closure: { schemaVersion: "1", topLevel: [], entries: [] },
    entry: "./workflow.js",
  };
}

describe("createWorkflowProbeExecutor", () => {
  test("returns a written result even when the child exit resolves before the read", async () => {
    // A one-shot child writes its result line and then exits promptly, so both
    // the buffered line and `handle.exited` become ready together. A handle
    // whose `exited` is ALREADY resolved and whose stdout carries a valid signed
    // result reproduces that race deterministically: the former `exit` race arm
    // would win and discard the written result; racing only the line must
    // return it.
    const projection = {
      id: "race-fixture",
      triggers: [],
      stepOrder: [],
      steps: {},
    };
    const raceSpawner: ProbeChildSpawner = ({ env }) => {
      const channelId = env["PROBE_IPC_CHANNEL_ID"];
      const hmacHex = env["PROBE_IPC_HMAC_KEY"];
      if (channelId === undefined || hmacHex === undefined) {
        throw new Error("probe spawn env missing channel id / hmac key");
      }
      const hmacKey = hexDecode(hmacHex);
      const stdout = new ReadableStream<Uint8Array>({
        async start(controller) {
          const payload = {
            ok: true as const,
            projection,
            grants: ["cap:probe-race"],
            grantWalkSnapshot: {
              perStep: [{ stepId: "s1", grants: ["cap:probe-race"], grantEffects: {} }],
              grantRequirements: [],
            },
            wireHash: "a".repeat(64),
          };
          const envelope: FrameEnvelope = { seq: 0, channelId, payload };
          const mac = hexEncode(await signHmac(encodeEnvelope(envelope), hmacKey));
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ envelope, mac })}\n`));
          controller.close();
        },
      });
      return {
        pid: 4242,
        stdout,
        exited: Promise.resolve(0),
        kill: () => {
          /* mock handle: already exited, nothing to reap */
        },
      };
    };

    const materialize: MaterializeWorkflowClosure = () =>
      Promise.resolve({
        packageDir: "/unused-by-the-race-spawner",
        cleanup: () => Promise.resolve(),
      });

    const executor = createWorkflowProbeExecutor({
      materialize,
      spawnProbeChild: raceSpawner,
    });

    const result = await executor.probe(probeFrame());
    expect(result.projection).toEqual(projection);
    expect(result.grants).toEqual(["cap:probe-race"]);
    expect(result.grantWalkSnapshot).toEqual({
      perStep: [{ stepId: "s1", grants: ["cap:probe-race"], grantEffects: {} }],
      grantRequirements: [],
    });
    expect(result.wireHash).toBe("a".repeat(64));
  });
});
