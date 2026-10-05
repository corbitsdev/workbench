import { describe, expect, test } from "bun:test";
import { generateId } from "../../../../../vendor/intx/hub-common/src/ids";
import { assertNoLeakedInternalId } from "./id-leak-guard";

const KINDS: Parameters<typeof generateId>[0][] = [
  "tenant",
  "principal",
  "principalKey",
  "role",
  "grant",
  "federationTrust",
  "provider",
  "oauthClient",
  "credential",
  "wallet",
  "transaction",
  "offering",
  "model",
  "modelProvider",
  "modelOffering",
  "modelPricing",
  "session",
  "sessionMail",
  "inferenceTurn",
  "turnPart",
  "asset",
  "gitToken",
  "workflowRun",
  "approval",
  "signal",
  "workflowDefinition",
  "workflowDefinitionVersion",
];

describe("assertNoLeakedInternalId", () => {
  test.each(KINDS)("catches a generated %s id", (kind) => {
    const id = generateId(kind);
    expect(() => assertNoLeakedInternalId(id, "title")).toThrow("internal identifier");
    expect(() => assertNoLeakedInternalId(`Open ${id} now`, "title")).toThrow(
      "internal identifier",
    );
  });

  test("passes ordinary text", () => {
    expect(() => assertNoLeakedInternalId("Weekly digest", "title")).not.toThrow();
  });
});
