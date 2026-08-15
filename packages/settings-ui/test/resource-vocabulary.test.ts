// CL-6077: the grant preview sentence and table both used to splice the
// raw resource slug (`workflow-definition`, `git-token`) straight into
// "plain-language" copy. `GRANT_RESOURCE_LABEL` is the one map both
// consume, so a person reads "agent workflows," never "workflow-definition."

import { describe, expect, test } from "bun:test";

import {
  GRANT_RESOURCES,
  GRANT_RESOURCE_LABEL,
} from "../src/resource-vocabulary";

describe("GRANT_RESOURCE_LABEL", () => {
  test("covers every resource in GRANT_RESOURCES with a distinct, plain-language label", () => {
    for (const resource of GRANT_RESOURCES) {
      expect(GRANT_RESOURCE_LABEL[resource]).toBeDefined();
      expect(GRANT_RESOURCE_LABEL[resource].length).toBeGreaterThan(0);
    }
    const labels = GRANT_RESOURCES.map(
      (resource) => GRANT_RESOURCE_LABEL[resource],
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("never uses a raw hyphen/underscore slug as its own label", () => {
    for (const resource of GRANT_RESOURCES) {
      const label = GRANT_RESOURCE_LABEL[resource];
      expect(label).not.toContain("-");
      expect(label).not.toContain("_");
    }
  });

  test("reads naturally in the preview sentence's 'on {label}' slot", () => {
    expect(GRANT_RESOURCE_LABEL["workflow-definition"]).toBe(
      "agent workflows",
    );
    expect(GRANT_RESOURCE_LABEL["model-provider"]).toBe("model providers");
    expect(GRANT_RESOURCE_LABEL["git-token"]).toBe("repository access");
    expect(GRANT_RESOURCE_LABEL.oauth_client).toBe("app connections");
    expect(GRANT_RESOURCE_LABEL["agent-data"]).toBe("agent data");
  });
});
