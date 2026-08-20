import { describe, expect, test } from "bun:test";
import { joinRunParticipant } from "./run-participant";
import { parseParticipants } from "./participants";

function fakeStore(existing: Record<string, unknown>) {
  const updates: unknown[] = [];
  return {
    updates,
    store: {
      getWorkbenchSettings: async () => ({
        tenantId: "ten_1",
        workbenchId: "chn_1",
        kind: "workbench",
        settings: existing,
      }),
      updateWorkbenchSettings: async (input: {
        settings: Record<string, unknown>;
      }) => {
        updates.push(input);
        return { settings: input.settings };
      },
    },
  };
}

describe("joinRunParticipant", () => {
  test("appends the run address as a workbench participant, keeping the others", async () => {
    const { store, updates } = fakeStore({
      "chat/participants": [{ address: "wfr_myra@acme.test", handle: "myra" }],
      "chat/name": "GTM",
    });
    await joinRunParticipant(
      { store: store as never },
      {
        tenantId: "ten_1",
        workbenchId: "chn_1",
        principalId: "usr_1",
        address: "wfr_run@acme.test",
        handle: "daily-digest",
      },
    );
    expect(updates).toHaveLength(1);
    const written = updates[0] as {
      updatedBy: string;
      settings: Record<string, unknown>;
    };
    expect(written.updatedBy).toBe("usr_1");
    expect(written.settings["chat/name"]).toBe("GTM");
    expect(parseParticipants(written.settings["chat/participants"])).toEqual([
      { address: "wfr_myra@acme.test", handle: "myra" },
      { address: "wfr_run@acme.test", handle: "daily-digest" },
    ]);
  });

  test("throws when the workbench does not exist in the tenant", async () => {
    const store = {
      getWorkbenchSettings: async () => undefined,
      updateWorkbenchSettings: async () => {
        throw new Error("must not be called");
      },
    };
    await expect(
      joinRunParticipant(
        { store: store as never },
        {
          tenantId: "ten_1",
          workbenchId: "chn_missing",
          principalId: "usr_1",
          address: "wfr_run@acme.test",
          handle: "x",
        },
      ),
    ).rejects.toThrow(/chn_missing/);
  });
});
