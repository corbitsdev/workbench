import { describe, expect, test } from "bun:test";
import { readHubConfig } from "../src/config.ts";

const validEnv = {
  DATABASE_URL: "postgres://workbench:workbench@localhost:5432/workbench",
  BASE_URL: "http://localhost:3000",
  SESSION_SECRET: "insecure-dev-only-session-secret-0000",
  HUB_DATA_DIR: ".data/hub",
  HUB_STATIC_DIR: "apps/hub/public",
};

function readExpectingError(env: Record<string, string | undefined>): string {
  try {
    readHubConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected readHubConfig to throw");
}

describe("readHubConfig", () => {
  test("returns typed config for a valid environment", () => {
    const config = readHubConfig(validEnv);
    expect(config).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      baseUrl: validEnv.BASE_URL,
      sessionSecret: validEnv.SESSION_SECRET,
      hubDataDir: validEnv.HUB_DATA_DIR,
      hubStaticDir: validEnv.HUB_STATIC_DIR,
    });
  });

  test("accepts postgresql:// and https:// URL forms", () => {
    const config = readHubConfig({
      ...validEnv,
      DATABASE_URL: "postgresql://workbench@localhost:5432/workbench",
      BASE_URL: "https://workbench.example.com",
    });
    expect(config.databaseUrl).toStartWith("postgresql://");
    expect(config.baseUrl).toStartWith("https://");
  });

  test("an empty environment reports every variable in one error", () => {
    const message = readExpectingError({});
    for (const name of [
      "DATABASE_URL",
      "BASE_URL",
      "SESSION_SECRET",
      "HUB_DATA_DIR",
      "HUB_STATIC_DIR",
    ]) {
      expect(message).toContain(name);
    }
  });

  test("a malformed value is rejected naming the variable and the shape", () => {
    const message = readExpectingError({
      ...validEnv,
      DATABASE_URL: "mysql://nope",
      SESSION_SECRET: "too-short",
    });
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("Postgres connection URL");
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("HUB_DATA_DIR");
  });
});
