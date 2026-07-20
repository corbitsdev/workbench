import { describe, expect, test } from "bun:test";
import {
  buildApprovalArgRows,
  humanizeArgKey,
  truncateId,
} from "./native-approval-args";

const TEAM_UUID = "937a3636-1a2b-4c5d-8e9f-0a1b2c3d4e5f";

describe("humanizeArgKey", () => {
  test("maps known keys to friendly labels", () => {
    expect(humanizeArgKey("title")).toBe("Title");
    expect(humanizeArgKey("teamId")).toBe("Team");
    expect(humanizeArgKey("priority")).toBe("Priority");
    expect(humanizeArgKey("description")).toBe("Description");
  });

  test("strips a trailing Id and title-cases unknown keys", () => {
    expect(humanizeArgKey("assigneeId")).toBe("Assignee");
    expect(humanizeArgKey("someCustomField")).toBe("Some custom field");
  });
});

describe("buildApprovalArgRows", () => {
  test("renders humanized label rows for each showable field", () => {
    const rows = buildApprovalArgRows("linear__create_issue", {
      title: "Fix the login bug",
      priority: 2,
    });
    const byLabel = new Map(rows.map((r) => [r.label, r.display]));
    expect(byLabel.get("Title")).toBe("Fix the login bug");
    // Linear priority 2 → "High".
    expect(byLabel.get("Priority")).toBe("High");
  });

  test("maps the full Linear priority scale only for Linear tools", () => {
    const linear = buildApprovalArgRows("linear__create_issue", {
      priority: 1,
    });
    expect(linear[0]?.display).toBe("Urgent");
    // A non-Linear tool leaves the raw number.
    const other = buildApprovalArgRows("acme__do_thing", { priority: 1 });
    expect(other[0]?.display).toBe("1");
  });

  test("resolves a team id to its name when a resolver supplies one", () => {
    const rows = buildApprovalArgRows(
      "linear__create_issue",
      { teamId: TEAM_UUID },
      {
        resolveId: (key, value) =>
          key === "teamId" && value === TEAM_UUID ? "Engineering" : null,
      },
    );
    expect(rows[0]?.label).toBe("Team");
    expect(rows[0]?.display).toBe("Engineering");
    expect(rows[0]?.kind).toBe("text");
  });

  test("truncates an unresolved id instead of showing a bare 36-char UUID", () => {
    const rows = buildApprovalArgRows("linear__create_issue", {
      teamId: TEAM_UUID,
    });
    expect(rows[0]?.kind).toBe("id");
    expect(rows[0]?.display).toBe("937a3636…");
    expect(rows[0]?.display.length).toBeLessThan(TEAM_UUID.length);
  });

  test("classifies a long text value as long (clamp + expand)", () => {
    const long = "x".repeat(200);
    const rows = buildApprovalArgRows("linear__create_issue", {
      description: long,
    });
    expect(rows[0]?.label).toBe("Description");
    expect(rows[0]?.kind).toBe("long");
  });

  test("renders a scalar list of recipients rather than dropping it", () => {
    const rows = buildApprovalArgRows("mail_send", {
      to: ["a@x.com", "b@y.com"],
    });
    expect(rows[0]?.label).toBe("To");
    expect(rows[0]?.display).toBe("a@x.com, b@y.com");
    expect(rows[0]?.kind).toBe("list");
  });

  test("omits empty fields", () => {
    const rows = buildApprovalArgRows("mail_send", { subject: "", to: [] });
    expect(rows).toHaveLength(0);
  });
});

describe("truncateId", () => {
  test("leaves a short id intact", () => {
    expect(truncateId("short")).toBe("short");
  });
  test("truncates a long id", () => {
    expect(truncateId(TEAM_UUID)).toBe("937a3636…");
  });
});
