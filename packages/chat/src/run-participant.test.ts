import { describe, expect, test } from "bun:test";
import { joinRunParticipant } from "./run-participant";
import type { ParticipantRecord } from "./participants";

function fakeStore(existing: Record<string, unknown>) {
  const updates: unknown[] = [];
  return {
    updates,
    store: {
      mutateWorkbenchParticipants: async (input: {
        updatedBy: string;
        mutate: (
          participants: readonly ParticipantRecord[],
        ) => ParticipantRecord[];
      }) => {
        const nextParticipants = input.mutate(
          (existing["chat/participants"] as ParticipantRecord[]) ?? [],
        );
        updates.push({ updatedBy: input.updatedBy, nextParticipants });
        return {
          settings: { ...existing, "chat/participants": nextParticipants },
        };
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
      nextParticipants: ParticipantRecord[];
    };
    expect(written.updatedBy).toBe("usr_1");
    expect(written.nextParticipants).toEqual([
      { address: "wfr_myra@acme.test", handle: "myra" },
      { address: "wfr_run@acme.test", handle: "daily-digest" },
    ]);
  });

  test("propagates the store's not-found error for a missing workbench", async () => {
    const store = {
      mutateWorkbenchParticipants: async () => {
        throw new Error(
          'mutateWorkbenchParticipants: no workbench_settings row for workbench "chn_missing"',
        );
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
