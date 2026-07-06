import { describe, expect, test } from "bun:test";
import { classifyRunError } from "./workflow-run-error";

describe("adversarial: provider-prefix echo into userMessage", () => {
  test("multi-word internal prefix before 'API error: NNN' is echoed verbatim", () => {
    const raw =
      "Failed while calling upstream host db-internal.prod.corp API error: 500 duplicate key value violates unique constraint";
    const r = classifyRunError(raw);
    expect(r.userMessage).not.toContain("db-internal.prod.corp");
  });

  test("internal hostname as 'provider' is echoed", () => {
    const raw = "Postgres.internal.corp API error: 503 upstream connect error";
    const r = classifyRunError(raw);
    expect(r.userMessage).not.toContain("Postgres.internal.corp");
  });

  test("identifier-ish prefix (underscored token) is echoed", () => {
    const raw = "Ses_01hxyzabc API error: 401 unauthorized";
    const r = classifyRunError(raw);
    expect(r.userMessage).not.toContain("Ses_01hxyzabc");
  });
});

describe("adversarial: misclassification of internal errors as network", () => {
  test("TypeError mentioning 'timedOut' property classified as network", () => {
    const raw =
      "TypeError: Cannot read properties of undefined (reading 'timedOut') at buildDeck (/app/packages/x/src/y.ts:42:7)";
    const r = classifyRunError(raw);
    expect(r.kind).toBe("internal");
  });

  test("internal error whose nested cause mentions 'timed out'", () => {
    const raw =
      "Error: artifact write failed: lock acquisition timed out at ArtifactStore.commit (/app/apps/hub/src/services/artifact-store.ts:120:11)";
    const r = classifyRunError(raw);
    expect(r.kind).toBe("internal");
  });

  test("429/rate limit text NOT at provider position does not trigger rate-limit", () => {
    const raw =
      "TypeError: cannot read foo at handleRateLimit (x.ts:1) status 429 rate limit";
    const r = classifyRunError(raw);
    expect(r.kind).toBe("internal");
  });
});

describe("adversarial: no raw echo in default paths", () => {
  const raws = [
    "",
    "   ",
    'insert into workflow_run_record ... violates constraint "wrr_pkey" (ins_abc, ses_def)',
    "fetch failed: https://internal-hub.railway.internal:8080/api/secret?token=abc",
    'Gamma API error: 429 {"message":"quota exceeded for key sk-live-abc"}',
    "Gamma API error: 500 <html>Internal Server Error at 10.0.3.17</html>",
  ];
  test("userMessage never echoes URLs, ids, tokens, or bodies", () => {
    for (const raw of raws) {
      const { userMessage } = classifyRunError(raw);
      for (const needle of [
        "ins_",
        "ses_",
        "railway.internal",
        "sk-live",
        "10.0.3.17",
        "constraint",
        "wrr_pkey",
        "token=",
        "<html>",
      ]) {
        expect(userMessage).not.toContain(needle);
      }
    }
  });

  test("lowercase-first provider labels (xAI, tools-x) classify as external, not internal", () => {
    const r = classifyRunError("xAI API error: 429 Too Many Requests");
    expect(r.kind).toBe("external-rate-limit");
  });

  test("does not throw on odd inputs; defaults to internal", () => {
    expect(classifyRunError("").kind).toBe("internal");
    expect(classifyRunError("   ").kind).toBe("internal");
    expect(classifyRunError("💥").kind).toBe("internal");
  });
});
