import { describe, expect, it } from "bun:test";
import {
  applyFilters,
  breakdown,
  buildDeleteUrl,
  parseFlags,
  type InstanceRow,
} from "./cleanup-instances";

describe("parseFlags", () => {
  it("parses value flags and boolean flags", () => {
    expect(parseFlags(["--status", "stopped", "--yes"])).toEqual({
      status: "stopped",
      yes: "true",
    });
  });

  it("ignores non-flag tokens", () => {
    expect(parseFlags(["foo", "--agent", "Freddy"])).toEqual({
      agent: "Freddy",
    });
  });
});

describe("applyFilters", () => {
  const rows: InstanceRow[] = [
    { id: "ins_a", agentName: "Myra", status: "running" },
    { id: "ins_b", agentName: "Freddy", status: "stopped" },
    { id: "ins_ses_x-intake", agentName: "intake", status: "deployed" },
  ];

  it("filters by status", () => {
    expect(applyFilters(rows, { status: "stopped" }).map((r) => r.id)).toEqual([
      "ins_b",
    ]);
  });

  it("filters by agent name substring (case-insensitive)", () => {
    expect(applyFilters(rows, { agent: "fred" }).map((r) => r.id)).toEqual([
      "ins_b",
    ]);
  });

  it("filters by id prefix", () => {
    expect(applyFilters(rows, { prefix: "ins_ses_" }).map((r) => r.id)).toEqual(
      ["ins_ses_x-intake"],
    );
  });

  it("returns all rows when no filter is given", () => {
    expect(applyFilters(rows, {})).toHaveLength(3);
  });
});

describe("breakdown", () => {
  it("counts by agent and status", () => {
    const rows: InstanceRow[] = [
      { id: "1", agentName: "Myra", status: "running" },
      { id: "2", agentName: "Myra", status: "running" },
      { id: "3", agentName: "Freddy", status: "stopped" },
    ];
    const counts = breakdown(rows);
    expect(counts.get("Myra · running")).toBe(2);
    expect(counts.get("Freddy · stopped")).toBe(1);
  });
});

describe("buildDeleteUrl", () => {
  it("requests a hard delete for an ephemeral workflow instance so cleanup converges", () => {
    expect(buildDeleteUrl("tenant-1", "ins_ses_x-intake")).toBe(
      "/api/v1/tenants/tenant-1/agents/instances/ins_ses_x-intake?hard=true",
    );
  });

  it("uses a plain soft delete for a non-ephemeral instance", () => {
    expect(buildDeleteUrl("tenant-1", "ins_myra")).toBe(
      "/api/v1/tenants/tenant-1/agents/instances/ins_myra",
    );
  });
});
