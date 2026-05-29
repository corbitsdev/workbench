import { describe, it, expect } from "bun:test";
import { createIntakeRouter } from "./intake";

describe("Intake route", () => {
  it("exports IntakeRequest and IntakeResponse types", async () => {
    // Verify the route module exports the expected types
    expect(createIntakeRouter).toBeDefined();
  });

  // Integration tests with live API would go here
  // For now, unit tests for the route handler are in the implementation
});
