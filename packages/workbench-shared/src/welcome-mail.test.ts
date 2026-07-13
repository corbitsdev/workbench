import { describe, expect, it } from "bun:test";
import { welcomeMailBody, welcomeMailSubject } from "./welcome-mail";

describe("welcomeMailSubject", () => {
  it("returns a stable, friendly subject", () => {
    expect(welcomeMailSubject()).toBe("Welcome to your workbench");
  });
});

describe("welcomeMailBody", () => {
  it("greets the member by name", () => {
    const body = welcomeMailBody({ memberName: "Alice" });
    expect(body).toContain("Hi Alice,");
  });

  it("falls back to a generic greeting when the name is blank", () => {
    const body = welcomeMailBody({ memberName: "  " });
    expect(body).toContain("Hi there,");
  });

  it("covers the required next-step topics", () => {
    const body = welcomeMailBody({ memberName: "Alice" });
    expect(body).toContain("Myra");
    expect(body).toContain("morning brief");
    expect(body).toContain("Schedule a workflow");
    expect(body).toContain("autonomy");
    expect(body).toContain("Connect the tools");
  });
});
