import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { DailyLinkedInIntakePayloadSchema } from "./daily-linkedin";
import { SelectedPersonSchema } from "./selected-person";

describe("DailyLinkedInIntakePayloadSchema", () => {
  it("accepts a selection of SelectedPerson pairs", () => {
    const out = DailyLinkedInIntakePayloadSchema({
      recipients: [{ refId: "u_alex", displayName: "Alex" }],
    });
    expect(out).toEqual({
      recipients: [{ refId: "u_alex", displayName: "Alex" }],
    });
  });

  // The recipient element type is not redeclared here — it IS
  // `SelectedPersonSchema`. If someone reintroduces a hand-written copy that
  // drifts (the CL-4581 defect), these two accept/reject in different places
  // and this fails.
  it("accepts exactly what SelectedPersonSchema accepts, element for element", () => {
    const cases: unknown[] = [
      { refId: "u_alex", displayName: "Alex" },
      { refId: "u_alex", displayName: "" },
      { refId: "", displayName: "Alex" },
      { displayName: "Alex" },
      { refId: "u_alex" },
      "u_alex",
      null,
    ];
    for (const candidate of cases) {
      const personOk = !(
        SelectedPersonSchema(candidate) instanceof type.errors
      );
      const listOk = !(
        DailyLinkedInIntakePayloadSchema({ recipients: [candidate] }) instanceof
        type.errors
      );
      expect({ candidate, listOk }).toEqual({ candidate, listOk: personOk });
    }
  });

  it("rejects an empty selection — empty means nobody", () => {
    expect(
      DailyLinkedInIntakePayloadSchema({ recipients: [] }) instanceof
        type.errors,
    ).toBe(true);
  });

  it("rejects a missing recipients field", () => {
    expect(DailyLinkedInIntakePayloadSchema({}) instanceof type.errors).toBe(
      true,
    );
  });

  it("rejects the retired bare-string selection shape", () => {
    expect(
      DailyLinkedInIntakePayloadSchema({ recipients: ["prn_a"] }) instanceof
        type.errors,
    ).toBe(true);
  });
});
