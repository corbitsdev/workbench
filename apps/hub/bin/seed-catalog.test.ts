import { describe, expect, it } from "bun:test";
import {
  listData,
  mergeCookies,
  resolveCredentialBinding,
  type CredentialRow,
} from "./seed-catalog";

describe("mergeCookies", () => {
  it("appends a new cookie", () => {
    expect(mergeCookies([], ["a=1; Path=/; HttpOnly"])).toEqual(["a=1"]);
  });

  it("replaces an existing cookie by name", () => {
    expect(mergeCookies(["a=1"], ["a=2; Path=/"])).toEqual(["a=2"]);
  });

  it("keeps unrelated cookies and appends the new one", () => {
    expect(mergeCookies(["a=1"], ["b=2; Secure"])).toEqual(["a=1", "b=2"]);
  });

  it("ignores malformed set-cookie headers", () => {
    expect(mergeCookies(["a=1"], [""])).toEqual(["a=1"]);
  });
});

describe("listData", () => {
  it("returns the data array", () => {
    expect(listData<number>({ data: [1, 2] })).toEqual([1, 2]);
  });

  it("returns [] when data is missing", () => {
    expect(listData({})).toEqual([]);
    expect(listData(null)).toEqual([]);
  });
});

describe("resolveCredentialBinding", () => {
  const credentials: CredentialRow[] = [
    {
      id: "cred_1",
      name: "opencode-zen",
      metadata: { baseURL: "https://zen.example/v1" },
    },
    { id: "cred_2", name: "no-base", metadata: { model: "x" } },
  ];

  it("returns id + baseURL for a credential with metadata.baseURL", () => {
    expect(resolveCredentialBinding(credentials, "opencode-zen")).toEqual({
      id: "cred_1",
      baseURL: "https://zen.example/v1",
    });
  });

  it("throws when the credential is absent", () => {
    expect(() => resolveCredentialBinding(credentials, "missing")).toThrow(
      /not found — run seed-credentials/,
    );
  });

  it("throws when the credential has no metadata.baseURL", () => {
    expect(() => resolveCredentialBinding(credentials, "no-base")).toThrow(
      /no metadata.baseURL/,
    );
  });
});
