import { describe, expect, test } from "bun:test";
import { slackChannelMintSession } from "./slack-channel-mint-session";

const TENANT_ID = "tnt_bench";
const OWNER_USER_ID = "user_owner";
const OWNER_COOKIES = ["session=owner"];

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
  });
});
