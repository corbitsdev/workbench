import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { initSentry } from "./sentry";

const initSpy = mock(() => undefined);

mock.module("@sentry/bun", () => ({
  init: initSpy,
}));

describe("initSentry", () => {
  let originalDsn: string | undefined;
  let originalEnvironment: string | undefined;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalDsn = process.env.SENTRY_DSN;
    originalEnvironment = process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    initSpy.mockReset();
    initSpy.mockImplementation(() => undefined);
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
    if (originalEnvironment === undefined) {
      delete process.env.SENTRY_ENVIRONMENT;
    } else {
      process.env.SENTRY_ENVIRONMENT = originalEnvironment;
    }
    warnSpy.mockRestore();
  });

  test("returns null and does not init when no DSN is set", async () => {
    const result = await initSentry();

    expect(result).toBeNull();
    expect(initSpy).not.toHaveBeenCalled();
  });

  test("defaults environment to 'production' when SENTRY_ENVIRONMENT is unset", async () => {
    process.env.SENTRY_DSN = "https://example@sentry.io/123";

    const result = await initSentry();

    expect(result).not.toBeNull();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledWith({
      dsn: "https://example@sentry.io/123",
      environment: "production",
      tracesSampleRate: 0.0,
    });
  });

  test("uses the configured environment, dsn, and traces sample rate", async () => {
    process.env.SENTRY_DSN = "https://example@sentry.io/456";
    process.env.SENTRY_ENVIRONMENT = "staging";

    const result = await initSentry();

    expect(result).not.toBeNull();
    expect(initSpy).toHaveBeenCalledWith({
      dsn: "https://example@sentry.io/456",
      environment: "staging",
      tracesSampleRate: 0.0,
    });
  });

  test("returns null and warns when init throws", async () => {
    process.env.SENTRY_DSN = "https://example@sentry.io/789";
    const failure = new Error("init failed");
    initSpy.mockImplementation(() => {
      throw failure;
    });

    const result = await initSentry();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to initialize Sentry",
      failure,
    );
  });
});
