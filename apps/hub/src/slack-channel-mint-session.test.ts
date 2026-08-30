import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureSync, resetSync } from "@intx/log";
import { createInMemoryWorkbenchTenancyStore } from "@corbits/chat";

import {
  mintSlackChannelWorkbench,
  slackChannelMintSession,
} from "./slack-channel-mint-session";

const TENANT_ID = "tnt_bench";
const OWNER_USER_ID = "user_owner";
const MEMBER_REF_ID = "user_slack_member";
const OWNER_COOKIES = ["session=owner"];

let records: { properties: Record<string, unknown> }[];

function installCapturingSink(): void {
  records = [];
  configureSync({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record as { properties: Record<string, unknown> });
      },
    },
    loggers: [
      { category: ["errors"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

beforeEach(() => installCapturingSink());
afterEach(() => resetSync());

describe("slackChannelMintSession", () => {
  test("mints as the bench owner, never as a Slack member", async () => {
    const sessionArgs: { userId: string; tenantId: string }[] = [];
    const result = await slackChannelMintSession({
      tenantId: TENANT_ID,
      getWorkbenchOwnerUserId: async (tenantId) => {
        expect(tenantId).toBe(TENANT_ID);
        return OWNER_USER_ID;
      },
      sessionFor: async (args) => {
        sessionArgs.push(args);
        return OWNER_COOKIES;
      },
    });

    expect(result).toEqual({
      ownerUserId: OWNER_USER_ID,
      cookies: OWNER_COOKIES,
    });
    expect(sessionArgs).toEqual([
      { userId: OWNER_USER_ID, tenantId: TENANT_ID },
    ]);
  });

  test("fails closed when the bench has no owner user id", async () => {
    await expect(
      slackChannelMintSession({
        tenantId: TENANT_ID,
        getWorkbenchOwnerUserId: async () => undefined,
        sessionFor: async () => OWNER_COOKIES,
      }),
    ).rejects.toThrow(`no owner user id for tenant "${TENANT_ID}"`);
    expect(records[0]?.properties.operation).toBe("slack.provisionChannel");
  });

  test("fails closed when the owner session cannot be minted", async () => {
    await expect(
      slackChannelMintSession({
        tenantId: TENANT_ID,
        getWorkbenchOwnerUserId: async () => OWNER_USER_ID,
        sessionFor: async () => undefined,
      }),
    ).rejects.toThrow(
      `could not mint a session for bench owner "${OWNER_USER_ID}"`,
    );
    expect(records[0]?.properties.operation).toBe("slack.provisionChannel");
    expect(records[0]?.properties.extra).toEqual({
      ownerUserId: OWNER_USER_ID,
    });
  });
});

describe("mintSlackChannelWorkbench", () => {
  test("a member-role Slack identity provisions via the owner session", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant(TENANT_ID);
    tenancy.grantManageInTenant(OWNER_USER_ID, TENANT_ID);

    const mintCalls: {
      creatorUserId: string;
      cookies: string[];
      parentTenantId: string;
    }[] = [];
    const sessionArgs: { userId: string; tenantId: string }[] = [];

    const result = await mintSlackChannelWorkbench(
      {
        tenantId: TENANT_ID,
        getWorkbenchOwnerUserId: (id) => tenancy.getWorkbenchOwnerUserId(id),
        sessionFor: async (args) => {
          sessionArgs.push(args);
          if (args.userId === MEMBER_REF_ID) return ["session=member"];
          if (args.userId === OWNER_USER_ID) return OWNER_COOKIES;
          return undefined;
        },
        chatTenancy: {
          createWorkbenchTenant: async (input) => {
            mintCalls.push({
              creatorUserId: input.creatorUserId,
              cookies: input.cookies,
              parentTenantId: input.parentTenantId,
            });
            return tenancy.createWorkbenchTenant(input);
          },
          addWorkbenchMember: (input) => tenancy.addWorkbenchMember(input),
        },
      },
      { name: "#eng", creatorRefId: MEMBER_REF_ID },
    );

    expect(sessionArgs).toEqual([
      { userId: OWNER_USER_ID, tenantId: TENANT_ID },
    ]);
    expect(mintCalls).toEqual([
      {
        creatorUserId: OWNER_USER_ID,
        cookies: OWNER_COOKIES,
        parentTenantId: TENANT_ID,
      },
    ]);
    expect(result.ownerUserId).toBe(OWNER_USER_ID);
    expect(result.channelId.length).toBeGreaterThan(0);

    const member = await tenancy.getTenantPrincipalByRefId(
      result.workbenchTenantId,
      MEMBER_REF_ID,
    );
    expect(member?.refId).toBe(MEMBER_REF_ID);
  });

  test("fails closed without minting when the owner session cannot be minted", async () => {
    const mintCalls: unknown[] = [];
    const memberCalls: unknown[] = [];

    await expect(
      mintSlackChannelWorkbench(
        {
          tenantId: TENANT_ID,
          getWorkbenchOwnerUserId: async () => OWNER_USER_ID,
          sessionFor: async () => undefined,
          chatTenancy: {
            createWorkbenchTenant: async (input) => {
              mintCalls.push(input);
              throw new Error("should not mint");
            },
            addWorkbenchMember: async (input) => {
              memberCalls.push(input);
              return undefined;
            },
          },
        },
        { name: "#eng", creatorRefId: MEMBER_REF_ID },
      ),
    ).rejects.toThrow(
      `could not mint a session for bench owner "${OWNER_USER_ID}"`,
    );

    expect(mintCalls).toEqual([]);
    expect(memberCalls).toEqual([]);
    expect(records[0]?.properties.operation).toBe("slack.provisionChannel");
  });
});
