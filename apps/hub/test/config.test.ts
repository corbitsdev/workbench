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
      socialProviders: {},
      signupRateLimit: { windowSeconds: 60, max: 5 },
      allowPlaintextSecrets: false,
      sidecarProvisioners: [{ id: "process" }],
      defaultSidecarProvisionerId: "process",
    });
  });

  test("provider env vars are no longer configuration", () => {
    const config = readHubConfig({
      ...validEnv,
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-oai-test",
      OLLAMA_BASE_URL: "http://localhost:11434",
      HUB_ADMIN_EMAIL: "owner@acme.example",
      HUB_ADMIN_PASSWORD: "correct-horse-battery",
    });
    expect(Object.keys(config).sort()).toEqual(
      [
        "allowPlaintextSecrets",
        "baseUrl",
        "databaseUrl",
        "defaultSidecarProvisionerId",
        "hubDataDir",
        "hubStaticDir",
        "sessionSecret",
        "signupRateLimit",
        "socialProviders",
        "sidecarProvisioners",
      ].sort(),
    );
  });

  describe("social providers", () => {
    test("absent by default", () => {
      expect(readHubConfig(validEnv).socialProviders).toEqual({});
    });

    test("a full Google pair enables google", () => {
      const config = readHubConfig({
        ...validEnv,
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
      });
      expect(config.socialProviders).toEqual({
        google: { clientId: "google-id", clientSecret: "google-secret" },
      });
    });

    test("a full GitHub pair enables github, independently of google", () => {
      const config = readHubConfig({
        ...validEnv,
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      expect(config.socialProviders).toEqual({
        github: { clientId: "github-id", clientSecret: "github-secret" },
      });
    });

    test("both providers can be configured together", () => {
      const config = readHubConfig({
        ...validEnv,
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      expect(Object.keys(config.socialProviders).sort()).toEqual(["github", "google"]);
    });

    test("a client id with no secret fails loudly at boot", () => {
      const message = readExpectingError({
        ...validEnv,
        GOOGLE_CLIENT_ID: "google-id",
      });
      expect(message).toContain("GOOGLE_CLIENT_ID");
      expect(message).toContain("GOOGLE_CLIENT_SECRET");
    });

    test("a client secret with no id fails loudly at boot", () => {
      const message = readExpectingError({
        ...validEnv,
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      expect(message).toContain("GITHUB_CLIENT_ID");
      expect(message).toContain("GITHUB_CLIENT_SECRET");
    });
  });

  test("the signup rate limit is configurable and defaults sanely", () => {
    const config = readHubConfig({
      ...validEnv,
      SIGNUP_RATE_LIMIT_WINDOW_SECONDS: "30",
      SIGNUP_RATE_LIMIT_MAX: "2",
    });
    expect(config.signupRateLimit).toEqual({ windowSeconds: 30, max: 2 });
  });

  test("huggingfaceOAuthClientId is absent by default", () => {
    expect(readHubConfig(validEnv).huggingfaceOAuthClientId).toBeUndefined();
  });

  test("HUGGINGFACE_OAUTH_CLIENT_ID enables the connect card's client id", () => {
    const config = readHubConfig({
      ...validEnv,
      HUGGINGFACE_OAUTH_CLIENT_ID: "hf-client-1",
    });
    expect(config.huggingfaceOAuthClientId).toBe("hf-client-1");
  });

  test("githubApiBaseUrl is absent by default", () => {
    expect(readHubConfig(validEnv).githubApiBaseUrl).toBeUndefined();
  });

  test("GITHUB_API_BASE_URL overrides the github connector's API origin", () => {
    const config = readHubConfig({
      ...validEnv,
      GITHUB_API_BASE_URL: "http://fake-github.test",
    });
    expect(config.githubApiBaseUrl).toBe("http://fake-github.test");
  });

  test("GITHUB_API_BASE_URL rejects a non-http(s) value", () => {
    const message = readExpectingError({
      ...validEnv,
      GITHUB_API_BASE_URL: "not-a-url",
    });
    expect(message).toContain("GITHUB_API_BASE_URL");
  });

  test("CREDENTIAL_ENCRYPTION_KEY absent by default", () => {
    expect(readHubConfig(validEnv).credentialEncryptionKeyHex).toBeUndefined();
  });

  test("CREDENTIAL_ENCRYPTION_KEY accepts a 64-char hex key", () => {
    const key = "a".repeat(64);
    const config = readHubConfig({
      ...validEnv,
      CREDENTIAL_ENCRYPTION_KEY: key,
    });
    expect(config.credentialEncryptionKeyHex).toBe(key);
  });

  test("CREDENTIAL_ENCRYPTION_KEY rejects a key of the wrong length or shape", () => {
    const message = readExpectingError({
      ...validEnv,
      CREDENTIAL_ENCRYPTION_KEY: "not-hex-and-too-short",
    });
    expect(message).toContain("CREDENTIAL_ENCRYPTION_KEY");
  });

  test("PRINCIPAL_KEY_ENCRYPTION_KEY absent by default", () => {
    expect(readHubConfig(validEnv).principalKeyEncryptionKeyHex).toBeUndefined();
  });

  test("PRINCIPAL_KEY_ENCRYPTION_KEY accepts a 64-char hex key", () => {
    const key = "b".repeat(64);
    const config = readHubConfig({
      ...validEnv,
      PRINCIPAL_KEY_ENCRYPTION_KEY: key,
    });
    expect(config.principalKeyEncryptionKeyHex).toBe(key);
  });

  test("PRINCIPAL_KEY_ENCRYPTION_KEY rejects a key of the wrong length or shape", () => {
    const message = readExpectingError({
      ...validEnv,
      PRINCIPAL_KEY_ENCRYPTION_KEY: "not-hex-and-too-short",
    });
    expect(message).toContain("PRINCIPAL_KEY_ENCRYPTION_KEY");
  });

  test("ALLOW_PLAINTEXT_SECRETS never substitutes a principal key — the key stays unset", () => {
    const config = readHubConfig({
      ...validEnv,
      BASE_URL: "http://localhost:3000",
      ALLOW_PLAINTEXT_SECRETS: "1",
    });
    expect(config.allowPlaintextSecrets).toBe(true);
    expect(config.principalKeyEncryptionKeyHex).toBeUndefined();
  });

  test("allowPlaintextSecrets is false by default", () => {
    expect(readHubConfig(validEnv).allowPlaintextSecrets).toBe(false);
  });

  test("allowGitInsideWorkTree is omitted by default", () => {
    expect(readHubConfig(validEnv).allowGitInsideWorkTree).toBeUndefined();
  });

  test("HUB_ALLOW_GIT_INSIDE_WORK_TREE='1' or 'true' opts in", () => {
    expect(
      readHubConfig({ ...validEnv, HUB_ALLOW_GIT_INSIDE_WORK_TREE: "1" }).allowGitInsideWorkTree,
    ).toBe(true);
    expect(
      readHubConfig({ ...validEnv, HUB_ALLOW_GIT_INSIDE_WORK_TREE: "true" }).allowGitInsideWorkTree,
    ).toBe(true);
  });

  test("HUB_ALLOW_GIT_INSIDE_WORK_TREE rejects any other value", () => {
    const message = readExpectingError({
      ...validEnv,
      HUB_ALLOW_GIT_INSIDE_WORK_TREE: "yes",
    });
    expect(message).toContain("HUB_ALLOW_GIT_INSIDE_WORK_TREE");
  });

  test("ALLOW_PLAINTEXT_SECRETS='1' or 'true' opts in", () => {
    expect(readHubConfig({ ...validEnv, ALLOW_PLAINTEXT_SECRETS: "1" }).allowPlaintextSecrets).toBe(
      true,
    );
    expect(
      readHubConfig({ ...validEnv, ALLOW_PLAINTEXT_SECRETS: "true" }).allowPlaintextSecrets,
    ).toBe(true);
  });

  test("ALLOW_PLAINTEXT_SECRETS rejects any other value", () => {
    const message = readExpectingError({
      ...validEnv,
      ALLOW_PLAINTEXT_SECRETS: "yes",
    });
    expect(message).toContain("ALLOW_PLAINTEXT_SECRETS");
  });

  test("ALLOW_PLAINTEXT_SECRETS boots fine against a loopback BASE_URL", () => {
    expect(
      readHubConfig({
        ...validEnv,
        BASE_URL: "http://localhost:3000",
        ALLOW_PLAINTEXT_SECRETS: "1",
      }).allowPlaintextSecrets,
    ).toBe(true);
    expect(
      readHubConfig({
        ...validEnv,
        BASE_URL: "http://127.0.0.1:3000",
        ALLOW_PLAINTEXT_SECRETS: "1",
      }).allowPlaintextSecrets,
    ).toBe(true);
  });

  test("ALLOW_PLAINTEXT_SECRETS refuses to boot against a non-loopback BASE_URL", () => {
    const message = readExpectingError({
      ...validEnv,
      BASE_URL: "https://workbench.example.com",
      ALLOW_PLAINTEXT_SECRETS: "1",
    });
    expect(message).toContain("ALLOW_PLAINTEXT_SECRETS");
    expect(message).toContain("BASE_URL");
  });

  test("a non-loopback BASE_URL boots fine without ALLOW_PLAINTEXT_SECRETS", () => {
    const config = readHubConfig({
      ...validEnv,
      BASE_URL: "https://workbench.example.com",
      CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
    });
    expect(config.allowPlaintextSecrets).toBe(false);
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

  describe("sidecarProvisioners", () => {
    test("an unconfigured install registers the process backend as its sole default", () => {
      const config = readHubConfig(validEnv);
      expect(config.sidecarProvisioners).toEqual([{ id: "process" }]);
      expect(config.defaultSidecarProvisionerId).toBe("process");
    });

    test("the process backend's optional overrides reach its config", () => {
      const config = readHubConfig({
        ...validEnv,
        PROCESS_PROVISIONER_SIDECAR_ENTRY: "/opt/sidecar/index.js",
        PROCESS_PROVISIONER_RUNTIME: "/usr/bin/node",
      });
      expect(config.sidecarProvisioners).toEqual([
        {
          id: "process",
          sidecarEntryPath: "/opt/sidecar/index.js",
          runtimePath: "/usr/bin/node",
        },
      ]);
    });

    test("process is a listable id like any other backend", () => {
      const config = readHubConfig({
        ...validEnv,
        SIDECAR_PROVISIONERS: "process",
      });
      expect(config.sidecarProvisioners).toEqual([{ id: "process" }]);
      expect(config.defaultSidecarProvisionerId).toBe("process");
    });

    test("an explicit list without process does not get the default backend", () => {
      const config = readHubConfig({
        ...validEnv,
        SIDECAR_PROVISIONERS: "docker",
        DOCKER_PROVISIONER_IMAGE: "ghcr.io/corbits/sidecar:latest",
      });
      expect(config.sidecarProvisioners.map((one) => one.id)).toEqual(["docker"]);
    });

    test("SIDECAR_PROVISIONERS=docker with an image is wired and becomes the default", () => {
      const config = readHubConfig({
        ...validEnv,
        SIDECAR_PROVISIONERS: "docker",
        DOCKER_PROVISIONER_IMAGE: "ghcr.io/corbits/sidecar:latest",
      });
      expect(config.sidecarProvisioners).toEqual([
        { id: "docker", image: "ghcr.io/corbits/sidecar:latest" },
      ]);
      expect(config.defaultSidecarProvisionerId).toBe("docker");
    });

    test("SIDECAR_PROVISIONERS=docker without DOCKER_PROVISIONER_IMAGE fails loudly at boot", () => {
      const message = readExpectingError({
        ...validEnv,
        SIDECAR_PROVISIONERS: "docker",
      });
      expect(message).toContain("DOCKER_PROVISIONER_IMAGE");
      expect(message).toContain("SIDECAR_PROVISIONERS includes docker");
    });

    test("rejects a provisioner id no backend implements", () => {
      const message = readExpectingError({
        ...validEnv,
        SIDECAR_PROVISIONERS: "firecracker",
      });
      expect(message).toContain("unknown backend firecracker");
    });

    test("rejects a duplicate id", () => {
      const message = readExpectingError({
        ...validEnv,
        SIDECAR_PROVISIONERS: "docker,docker",
        DOCKER_PROVISIONER_IMAGE: "ghcr.io/corbits/sidecar:latest",
      });
      expect(message).toContain("more than once");
    });

    test("SIDECAR_DEFAULT_PROVISIONER selects the default among several ids", () => {
      const config = readHubConfig({
        ...validEnv,
        SIDECAR_PROVISIONERS: "docker",
        SIDECAR_DEFAULT_PROVISIONER: "docker",
        DOCKER_PROVISIONER_IMAGE: "ghcr.io/corbits/sidecar:latest",
      });
      expect(config.defaultSidecarProvisionerId).toBe("docker");
    });

    test("SIDECAR_DEFAULT_PROVISIONER naming an unlisted id fails loudly", () => {
      const message = readExpectingError({
        ...validEnv,
        SIDECAR_PROVISIONERS: "docker",
        SIDECAR_DEFAULT_PROVISIONER: "e2b",
        DOCKER_PROVISIONER_IMAGE: "ghcr.io/corbits/sidecar:latest",
      });
      expect(message).toContain("is not listed in SIDECAR_PROVISIONERS");
    });

    test("SIDECAR_DEFAULT_PROVISIONER set with SIDECAR_PROVISIONERS unset fails loudly", () => {
      const message = readExpectingError({
        ...validEnv,
        SIDECAR_DEFAULT_PROVISIONER: "docker",
      });
      expect(message).toContain("SIDECAR_PROVISIONERS is unset");
    });
  });

  describe("sidecarWebSocketUrl", () => {
    test("is undefined when HUB_SIDECAR_WEBSOCKET_URL is unset", () => {
      expect(readHubConfig(validEnv).sidecarWebSocketUrl).toBeUndefined();
    });

    test("is read from HUB_SIDECAR_WEBSOCKET_URL when set", () => {
      const config = readHubConfig({
        ...validEnv,
        HUB_SIDECAR_WEBSOCKET_URL: "ws://sidecar-host.internal:3000/api/sidecars/ws",
      });
      expect(config.sidecarWebSocketUrl).toBe("ws://sidecar-host.internal:3000/api/sidecars/ws");
    });

    test("rejects a value that is not a ws(s):// URL", () => {
      const message = readExpectingError({
        ...validEnv,
        HUB_SIDECAR_WEBSOCKET_URL: "http://not-a-websocket-url",
      });
      expect(message).toContain("HUB_SIDECAR_WEBSOCKET_URL");
    });
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
