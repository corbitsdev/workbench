import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CREDENTIAL_PROVIDER_CATALOG } from "@workbench/shared";
import { buildEntries } from "./seed-credentials";

// Provider plugins used for LLM inference credentials. Everything the seeder
// emits on any OTHER plugin is a tool credential, and every tool credential
// must be manageable from the Owner UI (i.e. present in the catalog below).
const INFERENCE_PLUGINS = new Set([
  "openai-compatible",
  "openai",
  "anthropic",
  "google-genai",
  "xai",
]);

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

  it("includes notion entry with REST baseURL when NOTION_API_KEY is set", () => {
    process.env["NOTION_API_KEY"] = "notion_test123";

    const entries = buildEntries();

    const notion = entries.find((e) => e.providerName === "notion");
    expect(notion).toBeDefined();
    expect(notion?.secret).toBe("notion_test123");
    expect(notion?.providerPlugin).toBe("notion");
    expect(notion?.metadata?.["baseURL"]).toBe("https://api.notion.com");
  });

  it("omits notion entry when NOTION_API_KEY is not set", () => {
    delete process.env["NOTION_API_KEY"];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === "notion")).toBeUndefined();
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

  it("includes the corbits-default-bifrost entry with baseURL and model when BIFROST_API_KEY is set", () => {
    process.env["BIFROST_API_KEY"] = "vk-test123";
    process.env["BIFROST_BASE_URL"] = "http://bifrost.example:8080/v1";
    process.env["BIFROST_MODEL"] = "openai/gpt-4o-mini";
    process.env["BIFROST_CREDENTIAL_NAME"] = "Corbits Default Bifrost LLM";

    const entries = buildEntries();

    const bifrost = entries.find(
      (e) => e.providerName === "corbits-default-bifrost",
    );
    expect(bifrost).toBeDefined();
    expect(bifrost?.secret).toBe("vk-test123");
    expect(bifrost?.providerPlugin).toBe("openai-compatible");
    expect(bifrost?.credentialName).toBe("Corbits Default Bifrost LLM");
    expect(bifrost?.metadata).toEqual({
      model: "openai/gpt-4o-mini",
      baseURL: "http://bifrost.example:8080/v1",
    });
  });

  it("defaults the corbits-default-bifrost credential name to 'Corbits Default Bifrost'", () => {
    process.env["BIFROST_API_KEY"] = "vk-test123";
    process.env["BIFROST_BASE_URL"] = "http://bifrost.example:8080/v1";
    delete process.env["BIFROST_CREDENTIAL_NAME"];

    const bifrost = buildEntries().find(
      (e) => e.providerName === "corbits-default-bifrost",
    );
    expect(bifrost?.credentialName).toBe("Corbits Default Bifrost");
  });

  it("omits the corbits-default-bifrost entry when BIFROST_API_KEY is not set", () => {
    delete process.env["BIFROST_API_KEY"];

    const entries = buildEntries();

    expect(
      entries.find((e) => e.providerName === "corbits-default-bifrost"),
    ).toBeUndefined();
  });

  it("omits the corbits-default-bifrost entry when BIFROST_BASE_URL is not set (no default for a self-hosted gateway)", () => {
    process.env["BIFROST_API_KEY"] = "vk-test123";
    delete process.env["BIFROST_BASE_URL"];

    const entries = buildEntries();

    expect(
      entries.find((e) => e.providerName === "corbits-default-bifrost"),
    ).toBeUndefined();
  });

  it("adds the native /anthropic and /genai Bifrost surfaces sharing the one virtual key", () => {
    process.env["BIFROST_API_KEY"] = "vk-shared";
    process.env["BIFROST_BASE_URL"] = "http://bifrost.example:8080/v1";
    process.env["BIFROST_ANTHROPIC_BASE_URL"] =
      "http://bifrost.example:8080/anthropic";
    process.env["BIFROST_GENAI_BASE_URL"] = "http://bifrost.example:8080/genai";

    const entries = buildEntries();

    const anthropic = entries.find(
      (e) => e.providerName === "corbits-default-bifrost-anthropic",
    );
    expect(anthropic).toBeDefined();
    expect(anthropic?.secret).toBe("vk-shared");
    expect(anthropic?.providerPlugin).toBe("anthropic");
    expect(anthropic?.credentialName).toBe("Corbits Default Bifrost Anthropic");
    expect(anthropic?.metadata?.["baseURL"]).toBe(
      "http://bifrost.example:8080/anthropic",
    );

    const genai = entries.find(
      (e) => e.providerName === "corbits-default-bifrost-genai",
    );
    expect(genai).toBeDefined();
    expect(genai?.secret).toBe("vk-shared");
    expect(genai?.providerPlugin).toBe("google-genai");
    expect(genai?.credentialName).toBe("Corbits Default Bifrost GenAI");
    expect(genai?.metadata?.["baseURL"]).toBe(
      "http://bifrost.example:8080/genai",
    );
  });

  it("gates each Bifrost surface independently — a native surface seeds without the /v1 base URL", () => {
    process.env["BIFROST_API_KEY"] = "vk-shared";
    delete process.env["BIFROST_BASE_URL"];
    process.env["BIFROST_GENAI_BASE_URL"] = "http://bifrost.example:8080/genai";
    delete process.env["BIFROST_ANTHROPIC_BASE_URL"];

    const entries = buildEntries();

    // The /v1 surface is skipped (its base URL is unset)...
    expect(
      entries.find((e) => e.providerName === "corbits-default-bifrost"),
    ).toBeUndefined();
    // ...but the /genai surface still seeds on its own base URL.
    const genai = entries.find(
      (e) => e.providerName === "corbits-default-bifrost-genai",
    );
    expect(genai).toBeDefined();
    expect(genai?.secret).toBe("vk-shared");
    expect(genai?.metadata?.["baseURL"]).toBe(
      "http://bifrost.example:8080/genai",
    );
  });

  it("omits the native Bifrost surfaces when their base URL is unset even if the key is set", () => {
    process.env["BIFROST_API_KEY"] = "vk-shared";
    process.env["BIFROST_BASE_URL"] = "http://bifrost.example:8080/v1";
    delete process.env["BIFROST_ANTHROPIC_BASE_URL"];
    delete process.env["BIFROST_GENAI_BASE_URL"];

    const entries = buildEntries();

    expect(
      entries.find(
        (e) => e.providerName === "corbits-default-bifrost-anthropic",
      ),
    ).toBeUndefined();
    expect(
      entries.find((e) => e.providerName === "corbits-default-bifrost-genai"),
    ).toBeUndefined();
  });

  it("omits the native Bifrost surfaces when the virtual key is unset even if base URLs are set", () => {
    delete process.env["BIFROST_API_KEY"];
    process.env["BIFROST_ANTHROPIC_BASE_URL"] =
      "http://bifrost.example:8080/anthropic";
    process.env["BIFROST_GENAI_BASE_URL"] = "http://bifrost.example:8080/genai";

    const entries = buildEntries();

    expect(
      entries.find(
        (e) => e.providerName === "corbits-default-bifrost-anthropic",
      ),
    ).toBeUndefined();
    expect(
      entries.find((e) => e.providerName === "corbits-default-bifrost-genai"),
    ).toBeUndefined();
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

  it("surfaces every seeded tool credential in the Owner credential catalog", () => {
    // Set a key for every tool integration so buildEntries emits them all.
    process.env["GRANOLA_API_KEY"] = "k";
    process.env["EXA_API_KEY"] = "k";
    process.env["FIRECRAWL_API_KEY"] = "k";
    process.env["GAMMA_API_KEY"] = "k";
    process.env["GITHUB_API_KEY"] = "k";
    process.env["LINEAR_API_KEY"] = "k";
    process.env["ATTIO_API_KEY"] = "k";
    process.env["VERCEL_API_KEY"] = "k";
    process.env["YOUTUBE_API_KEY"] = "k";
    process.env["SCRAPECREATORS_API_KEY"] = "k";
    process.env["BLUESKY_APP_PASSWORD"] = "k";
    process.env["BLUESKY_HANDLE"] = "test.bsky.social";

    const catalogToolProviders = new Set(
      CREDENTIAL_PROVIDER_CATALOG.filter((e) => e.kind === "tool").map(
        (e) => e.providerName,
      ),
    );

    const seededToolProviders = buildEntries()
      .filter((e) => !INFERENCE_PLUGINS.has(e.providerPlugin))
      .map((e) => e.providerName);

    // Guards against the drift that hid vercel/scrapecreators/youtube/bluesky
    // from the Owner UI: a seed entry without a matching catalog row.
    expect(seededToolProviders.length).toBeGreaterThan(0);
    const missing = seededToolProviders.filter(
      (name) => !catalogToolProviders.has(name),
    );
    expect(missing).toEqual([]);
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
