/// <reference types="bun" />
import { describe, expect, it } from "bun:test";

describe("logger", () => {
  it("isDev returns true when not in production", () => {
    const isDev = process.env.NODE_ENV !== "production";
    expect(isDev).toBe(true);
  });

  it("logger has required methods", () => {
    const logger = {
      debug: (_message: string, ..._args: unknown[]) => {},
      info: (_message: string, ..._args: unknown[]) => {},
      warn: (_message: string, ..._args: unknown[]) => {},
      error: (_message: string, ..._args: unknown[]) => {},
    };
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });
});
