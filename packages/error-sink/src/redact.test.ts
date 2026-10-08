import { describe, expect, test } from "bun:test";
import { redactExtra, redactText } from "./redact";

describe("redactText", () => {
  test("redacts a bearer token", () => {
    expect(redactText("failed calling api with Bearer abc123.def456")).toBe(
      "failed calling api with [redacted]",
    );
  });

  test("redacts an authorization header fragment", () => {
    expect(redactText("Authorization: sk-live-abcdefgh1234")).toBe("[redacted]");
  });

  test("redacts a recognizable key-prefixed secret", () => {
    expect(redactText("using key sk-abcdefgh1234 to call provider")).toBe(
      "using key [redacted] to call provider",
    );
  });

  test("redacts a segmented provider key with uppercase/mixed-case suffix", () => {
    expect(redactText("using pk-live-ABCDEFGH12345678 to call provider")).toBe(
      "using [redacted] to call provider",
    );
  });

  test("redacts an uppercase sk- provider key", () => {
    expect(redactText("failed calling with sk-proj-ABCDEFGH12345678")).toBe(
      "failed calling with [redacted]",
    );
  });

  test("redacts a github_pat_ personal access token", () => {
    expect(redactText("auth failed github_pat_11abcdefghijklmnopGl000token")).toBe(
      "auth failed [redacted]",
    );
  });

  test("redacts a segmented rk- provider key", () => {
    expect(redactText("auth failed sending via rk-proj-ABCDEFGH12345678").toLowerCase()).toContain(
      "[redacted]",
    );
  });

  test("does not redact benign hyphenated words and paths under a key-like prefix", () => {
    // Over-redaction regression: the provider-key detector must not eat
    // ordinary hyphenated words/paths that merely start with a key prefix.
    expect(redactText("the build wrote pk-manifest.yaml to disk")).toBe(
      "the build wrote pk-manifest.yaml to disk",
    );
    expect(redactText("ran the sk-parallel-copy job")).toBe("ran the sk-parallel-copy job");
    expect(redactText("used pk-currency-converter to price it")).toBe(
      "used pk-currency-converter to price it",
    );
    expect(redactText("stalled on rk-pipeline-run-abcd")).toBe("stalled on rk-pipeline-run-abcd");
    expect(redactText("nudged the pk-abcdefgh record")).toBe("nudged the pk-abcdefgh record");
  });

  test("does not redact a hyphenated GitHub-prefixed word (never a PAT)", () => {
    expect(redactText("turned on ghp-garbage-collector nightly")).toBe(
      "turned on ghp-garbage-collector nightly",
    );
  });

  test("leaves ordinary text untouched", () => {
    expect(redactText("could not reach the hub")).toBe("could not reach the hub");
  });

  test("redacts sensitive query-param values in a URL while keeping it readable", () => {
    expect(
      redactText(
        "callback failed: https://api.example.com/cb?access_token=SECRETVALUE123&code=abc&state=xyz",
      ),
    ).toBe(
      "callback failed: https://api.example.com/cb?access_token=[redacted]&code=[redacted]&state=xyz",
    );
  });

  test("redacts token= style assignments in free text", () => {
    expect(redactText("failed request token=abc123xyz retries=3")).toBe(
      "failed request token=[redacted] retries=3",
    );
  });

  test("redacts a raw JWT with no keyword prefix", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzbm90YXJlYWxzaWc";
    expect(redactText(`session restore failed for ${jwt}`)).toBe(
      "session restore failed for [redacted]",
    );
  });

  test("redacts code=/key= only in query-string position, not free text", () => {
    expect(redactText('code=404 message="Not Found"')).toBe('code=404 message="Not Found"');
    expect(redactText('level=error msg="db timeout" code=DB_TIMEOUT retries=3')).toBe(
      'level=error msg="db timeout" code=DB_TIMEOUT retries=3',
    );
    expect(redactText("cache miss for key=user:1234:profile")).toBe(
      "cache miss for key=user:1234:profile",
    );
    expect(redactText("at /routes/key=handler.ts:12:5)")).toBe("at /routes/key=handler.ts:12:5)");
  });

  test("redacts code=/key= when they appear as a URL query param", () => {
    expect(redactText("https://api.example.com/authorize?client_id=abc&code=SECRETCODE")).toBe(
      "https://api.example.com/authorize?client_id=abc&code=[redacted]",
    );
    expect(redactText("https://api.example.com/data?key=APIKEYVALUE&format=json")).toBe(
      "https://api.example.com/data?key=[redacted]&format=json",
    );
  });

  test("does not let the value group run past a stack-frame's trailing text", () => {
    expect(redactText("auth failed token=abc123).authenticate() at line 4")).toBe(
      "auth failed token=[redacted]).authenticate() at line 4",
    );
  });

  test("redacts free-text keyword+space secret-shaped values", () => {
    // These forms slip past the assignment/`=` paths; a bare keyword followed
    // by a long, non-pure-English run is a leaked secret (e.g. an approval
    // title like "use password supersecret123 here").
    expect(redactText("use password supersecret123 here")).toBe("use [redacted] here");
    expect(redactText("use api_key ABcdEf123456 here")).toBe("use [redacted] here");
    expect(redactText("use secret hunter2-hunter2 here")).toBe("use [redacted] here");
    expect(redactText("use token xyzQWErtyuiop9 here")).toBe("use [redacted] here");
    expect(redactText("use access_token Abcdefgh12345678 now")).toBe("use [redacted] now");
  });

  test("does not redact free-text keyword+space ordinary prose", () => {
    // The value here is a short word or a pure-English word -- not a secret.
    expect(redactText("use secret sauce")).toBe("use secret sauce");
    expect(redactText("the token is here")).toBe("the token is here");
    expect(redactText("password recovery options")).toBe("password recovery options");
    expect(redactText("token ring protocol")).toBe("token ring protocol");
  });
});

describe("redactExtra", () => {
  test("redacts a value whose key looks like a credential", () => {
    expect(redactExtra({ apiKey: "sk-abcdefgh1234", userId: "user_1" })).toEqual({
      apiKey: "[redacted]",
      userId: "user_1",
    });
  });

  test("redacts nested objects by key", () => {
    expect(
      redactExtra({
        headers: { authorization: "Bearer abc.def", accept: "json" },
        repoIds: ["repo_1", "repo_2"],
      }),
    ).toEqual({
      headers: { authorization: "[redacted]", accept: "json" },
      repoIds: ["repo_1", "repo_2"],
    });
  });

  test("redacts an entire field whose key name itself looks secret-shaped", () => {
    // A field literally named "tokens" is redacted wholesale rather than
    // recursed into -- better to over-redact a suspicious key than miss a
    // real one nested inside it.
    expect(redactExtra({ tokens: ["tok_1", "tok_2"] })).toEqual({
      tokens: "[redacted]",
    });
  });

  test("scans plain string values for secret patterns even under a safe key", () => {
    expect(redactExtra({ detail: "rejected Bearer abc123" })).toEqual({
      detail: "rejected [redacted]",
    });
  });

  test("passes undefined through unchanged", () => {
    expect(redactExtra(undefined)).toBeUndefined();
  });

  test("redacts a raw secret string inside an array under a non-secret key", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzbm90YXJlYWxzaWc";
    expect(redactExtra({ sessions: [jwt, "plain-session-id"] })).toEqual({
      sessions: ["[redacted]", "plain-session-id"],
    });
  });
});
