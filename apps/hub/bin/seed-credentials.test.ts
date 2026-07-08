import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildEntries } from "./seed-credentials";

describe("seed-credentials buildEntries", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("includes github entry when GITHUB_API_KEY is set", () => {
    process.env["GITHUB_API_KEY"] = "ghp_test123";

    const entries = buildEntries();

    const github = entries.find((e) => e.providerName === "github");
    expect(github).toBeDefined();
    expect(github?.secret).toBe("ghp_test123");
    expect(github?.providerPlugin).toBe("github");
  });

  it("omits github entry when GITHUB_API_KEY is not set", () => {
    delete process.env["GITHUB_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "github")).toBeUndefined();
  });

  it("includes youtube entry when YOUTUBE_API_KEY is set", () => {
    process.env["YOUTUBE_API_KEY"] = "yt_test123";

    const entries = buildEntries();

    const youtube = entries.find((e) => e.providerName === "youtube");
    expect(youtube).toBeDefined();
    expect(youtube?.secret).toBe("yt_test123");
    expect(youtube?.providerPlugin).toBe("youtube");
  });

  it("omits youtube entry when YOUTUBE_API_KEY is not set", () => {
    delete process.env["YOUTUBE_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "youtube")).toBeUndefined();
  });

  it("includes linear entry with GraphQL baseURL when LINEAR_API_KEY is set", () => {
    process.env["LINEAR_API_KEY"] = "lin_api_test123";

    const entries = buildEntries();

    const linear = entries.find((e) => e.providerName === "linear");
    expect(linear).toBeDefined();
    expect(linear?.secret).toBe("lin_api_test123");
    expect(linear?.providerPlugin).toBe("linear");
    expect(linear?.metadata?.["baseURL"]).toBe(
      "https://api.linear.app/graphql",
    );
  });

  it("omits linear entry when LINEAR_API_KEY is not set", () => {
    delete process.env["LINEAR_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "linear")).toBeUndefined();
  });

  it("includes attio entry with REST baseURL when ATTIO_API_KEY is set", () => {
    process.env["ATTIO_API_KEY"] = "attio_test123";

    const entries = buildEntries();

    const attio = entries.find((e) => e.providerName === "attio");
    expect(attio).toBeDefined();
    expect(attio?.secret).toBe("attio_test123");
    expect(attio?.providerPlugin).toBe("attio");
    expect(attio?.metadata?.["baseURL"]).toBe("https://api.attio.com");
  });

  it("omits attio entry when ATTIO_API_KEY is not set", () => {
    delete process.env["ATTIO_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "attio")).toBeUndefined();
  });

  it("includes vercel entry with REST baseURL when VERCEL_API_KEY is set", () => {
    process.env["VERCEL_API_KEY"] = "vercel_test123";

    const entries = buildEntries();

    const vercel = entries.find((e) => e.providerName === "vercel");
    expect(vercel).toBeDefined();
    expect(vercel?.secret).toBe("vercel_test123");
    expect(vercel?.providerPlugin).toBe("vercel");
    expect(vercel?.metadata?.["baseURL"]).toBe("https://api.vercel.com");
  });

  it("omits vercel entry when VERCEL_API_KEY is not set", () => {
    delete process.env["VERCEL_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "vercel")).toBeUndefined();
  });

  it("includes anthropic provider metadata when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test123";

    const entries = buildEntries();

    const anthropic = entries.find((e) => e.providerName === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.secret).toBe("sk-ant-test123");
    expect(anthropic?.providerPlugin).toBe("anthropic");
    expect(anthropic?.credentialName).toBe("anthropic-api");
    expect(anthropic?.metadata).toEqual({
      baseURL: "https://api.anthropic.com",
    });
  });

  it("includes bluesky entry when both BLUESKY_APP_PASSWORD and BLUESKY_HANDLE are set", () => {
    process.env["BLUESKY_APP_PASSWORD"] = "xxxx-yyyy-zzzz";
    process.env["BLUESKY_HANDLE"] = "test.bsky.social";

    const entries = buildEntries();

    const bluesky = entries.find((e) => e.providerName === "bluesky");
    expect(bluesky).toBeDefined();
    expect(bluesky?.secret).toBe("xxxx-yyyy-zzzz");
    expect(bluesky?.providerPlugin).toBe("bluesky");
    expect(bluesky?.metadata?.["baseURL"]).toBe("test.bsky.social");
  });

  it("omits bluesky entry when BLUESKY_APP_PASSWORD is not set", () => {
    delete process.env["BLUESKY_APP_PASSWORD"];
    delete process.env["BLUESKY_HANDLE"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "bluesky")).toBeUndefined();
  });

  it("omits bluesky entry when BLUESKY_APP_PASSWORD is set but BLUESKY_HANDLE is missing", () => {
    process.env["BLUESKY_APP_PASSWORD"] = "xxxx-yyyy-zzzz";
    delete process.env["BLUESKY_HANDLE"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "bluesky")).toBeUndefined();
  });

  it("includes google-ai entry when GOOGLE_GEMINI_API_KEY is set", () => {
    process.env["GOOGLE_GEMINI_API_KEY"] = "gem-test-key";

    const entries = buildEntries();

    const google = entries.find((e) => e.credentialName === "google-ai");
    expect(google).toBeDefined();
    expect(google?.providerName).toBe("google-genai");
    expect(google?.secret).toBe("gem-test-key");
    expect(google?.metadata).toEqual({
      baseURL: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-lite",
    });
  });

  it("accepts GEMINI_API_KEY as an alias for the google-ai entry", () => {
    delete process.env["GOOGLE_GEMINI_API_KEY"];
    process.env["GEMINI_API_KEY"] = "gem-alias-key";

    const entries = buildEntries();

    const google = entries.find((e) => e.credentialName === "google-ai");
    expect(google?.secret).toBe("gem-alias-key");
  });

  it("omits google-ai entry when no Gemini key is set", () => {
    delete process.env["GOOGLE_GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];

    const entries = buildEntries();

    expect(
      entries.find((e) => e.credentialName === "google-ai"),
    ).toBeUndefined();
  });

  it("includes bifrost entry with baseURL and model when BIFROST_API_KEY is set", () => {
    process.env["BIFROST_API_KEY"] = "vk-test123";
    process.env["BIFROST_BASE_URL"] = "http://bifrost.example:8080/v1";
    process.env["BIFROST_MODEL"] = "openai/gpt-4o-mini";
    process.env["BIFROST_CREDENTIAL_NAME"] = "Bifrost LLM";

    const entries = buildEntries();

    const bifrost = entries.find((e) => e.providerName === "bifrost");
    expect(bifrost).toBeDefined();
    expect(bifrost?.secret).toBe("vk-test123");
    expect(bifrost?.providerPlugin).toBe("openai-compatible");
    expect(bifrost?.credentialName).toBe("Bifrost LLM");
    expect(bifrost?.metadata).toEqual({
      model: "openai/gpt-4o-mini",
      baseURL: "http://bifrost.example:8080/v1",
    });
  });

  it("omits bifrost entry when BIFROST_API_KEY is not set", () => {
    delete process.env["BIFROST_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "bifrost")).toBeUndefined();
  });

  it("keeps the unnumbered openai-compatible entry on the canonical provider", () => {
    process.env["OPENAI_COMPATIBLE_API_KEY"] = "sk-canonical";
    process.env["OPENAI_COMPATIBLE_CREDENTIAL_NAME"] = "opencode-zen";
    process.env["OPENAI_COMPATIBLE_BASE_URL"] = "https://opencode.ai/zen/v1";

    const entries = buildEntries();

    const canonical = entries.find((e) => e.credentialName === "opencode-zen");
    expect(canonical?.providerName).toBe("openai-compatible");
    expect(canonical?.providerPlugin).toBe("openai-compatible");
  });

  it("gives each numbered openai-compatible entry its own provider named after the credential", () => {
    process.env["OPENAI_COMPATIBLE_API_KEY_1"] = "sk-near";
    process.env["OPENAI_COMPATIBLE_CREDENTIAL_NAME_1"] = "near-ai";
    process.env["OPENAI_COMPATIBLE_BASE_URL_1"] = "https://api.near.ai/v1";

    const entries = buildEntries();

    const near = entries.find((e) => e.credentialName === "near-ai");
    expect(near?.providerName).toBe("near-ai");
    expect(near?.providerPlugin).toBe("openai-compatible");
    expect(near?.metadata?.["baseURL"]).toBe("https://api.near.ai/v1");
  });

  it("includes the optional Myra Title LLM entry when MYRA_TITLE_LLM_API_KEY is set", () => {
    process.env["MYRA_TITLE_LLM_API_KEY"] = "sk-title";
    process.env["MYRA_TITLE_LLM_MODEL"] = "gpt-4o-mini";
    process.env["MYRA_TITLE_LLM_BASE_URL"] = "https://titles.example/v1";

    const entries = buildEntries();

    const title = entries.find((e) => e.providerName === "Myra Title LLM");
    expect(title).toBeDefined();
    expect(title?.secret).toBe("sk-title");
    expect(title?.providerPlugin).toBe("openai-compatible");
    expect(title?.credentialName).toBe("Myra Title LLM");
    expect(title?.metadata?.["model"]).toBe("gpt-4o-mini");
    expect(title?.metadata?.["baseURL"]).toBe("https://titles.example/v1");
  });

  it("omits the Myra Title LLM entry when MYRA_TITLE_LLM_API_KEY is unset", () => {
    delete process.env["MYRA_TITLE_LLM_API_KEY"];

    const entries = buildEntries();

    expect(
      entries.find((e) => e.providerName === "Myra Title LLM"),
    ).toBeUndefined();
  });

  it("does not collide numbered openai-compatible providers with the canonical one", () => {
    process.env["OPENAI_COMPATIBLE_API_KEY"] = "sk-canonical";
    process.env["OPENAI_COMPATIBLE_CREDENTIAL_NAME"] = "opencode-zen";
    process.env["OPENAI_COMPATIBLE_API_KEY_1"] = "sk-near";
    process.env["OPENAI_COMPATIBLE_CREDENTIAL_NAME_1"] = "near-ai";

    const entries = buildEntries();

    const providerNames = entries
      .filter((e) => e.providerPlugin === "openai-compatible")
      .map((e) => e.providerName);
    expect(new Set(providerNames).size).toBe(providerNames.length);
  });
});
