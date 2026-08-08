import { describe, expect, test } from "bun:test";
import type { GrantRule, GrantStore } from "@intx/types/authz";

import {
  NotifyGrantMissingError,
  NotifySinkCredentialInvalidError,
  NotifySinkNotConfiguredError,
  resolveNotifyContext,
  type NotifyCredential,
} from "../src/index";

function grantStoreWith(grants: GrantRule[]): GrantStore {
  return {
    collectGrants: async () => grants,
    collectGrantsInChain: async () => grants,
  };
}

const slackCredential: NotifyCredential = {
  id: "crd_1",
  name: "team-slack",
  kind: "slack-bot-token",
};

function deliverGrant(resource: string): GrantRule {
  return {
    id: "grt_1",
    resource,
    action: "deliver",
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: "prn_1",
  };
}

describe("resolveNotifyContext", () => {
  test("resolves the credential when a matching grant allows delivery", async () => {
    const context = await resolveNotifyContext(
      {
        grantStore: grantStoreWith([deliverGrant("notify:slack")]),
        findSinkCredential: async () => slackCredential,
      },
      {
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "slack",
        credentialKind: "slack-bot-token",
      },
    );
    expect(context.credential.name).toBe("team-slack");
    expect(context.sinkName).toBe("slack");
  });

  test("fails closed when no grant covers the sink", async () => {
    await expect(
      resolveNotifyContext(
        {
          grantStore: grantStoreWith([deliverGrant("notify:email")]),
          findSinkCredential: async () => slackCredential,
        },
        {
          tenantId: "tnt_1",
          principalId: "prn_1",
          sinkName: "slack",
          credentialKind: "slack-bot-token",
        },
      ),
    ).rejects.toBeInstanceOf(NotifyGrantMissingError);
  });

  test("names the missing configuration when no credential is set up", async () => {
    await expect(
      resolveNotifyContext(
        {
          grantStore: grantStoreWith([deliverGrant("notify:slack")]),
          findSinkCredential: async () => null,
        },
        {
          tenantId: "tnt_1",
          principalId: "prn_1",
          sinkName: "slack",
          credentialKind: "slack-bot-token",
        },
      ),
    ).rejects.toBeInstanceOf(NotifySinkNotConfiguredError);
  });

  test("rejects a credential of the wrong kind rather than trying it", async () => {
    await expect(
      resolveNotifyContext(
        {
          grantStore: grantStoreWith([deliverGrant("notify:slack")]),
          findSinkCredential: async () => slackCredential,
        },
        {
          tenantId: "tnt_1",
          principalId: "prn_1",
          sinkName: "slack",
          credentialKind: "smtp",
        },
      ),
    ).rejects.toBeInstanceOf(NotifySinkCredentialInvalidError);
  });
});
