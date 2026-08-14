import { expect, test } from "bun:test";

import {
  createHttpXApiKeyCredentialProvider,
  HTTP_X_API_KEY_PROVIDER_KEY,
} from "./http-x-api-key-provider";

const ORIGIN = "https://api.exa.ai";

function materialSource(secret: string): { current: string } {
  return { current: secret };
}

test("key is http-x-api-key", () => {
  expect(createHttpXApiKeyCredentialProvider().key).toBe(
    HTTP_X_API_KEY_PROVIDER_KEY,
  );
});

test("sends the secret in x-api-key, not authorization", async () => {
  const captured: { apiKey: string | null; auth: string | null } = {
    apiKey: null,
    auth: null,
  };
  const provider = createHttpXApiKeyCredentialProvider({
    fetch: async (_input, init) => {
      const headers = init?.headers as Headers | undefined;
      captured.apiKey = headers?.get("x-api-key") ?? null;
      captured.auth = headers?.get("authorization") ?? null;
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "exa_real_key" }),
  });

  await mediated.fetch(`${ORIGIN}/search`);

  expect(captured.apiKey).toBe("exa_real_key");
  expect(captured.auth).toBeNull();
});

test("re-reads the material source per call, reflecting a rotation", async () => {
  const apiKeys: string[] = [];
  const material = materialSource("original-key");
  const provider = createHttpXApiKeyCredentialProvider({
    fetch: async (_input, init) => {
      apiKeys.push(
        (init?.headers as Headers | undefined)?.get("x-api-key") ?? "",
      );
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: material.current }),
  });

  await mediated.fetch(`${ORIGIN}/search`);
  material.current = "rotated-key";
  await mediated.fetch(`${ORIGIN}/search`);

  expect(apiKeys).toEqual(["original-key", "rotated-key"]);
});

test("refuses a cross-origin request rather than leaking the secret off the pinned origin", async () => {
  const provider = createHttpXApiKeyCredentialProvider({
    fetch: async () => new Response("{}", { status: 200 }),
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "exa_real_key" }),
  });

  await expect(
    mediated.fetch("https://evil.example.com/search"),
  ).rejects.toThrow(/refusing cross-origin request/);
});

test("forces redirect: manual so a same-origin 3xx never auto-follows off the handle", async () => {
  const captured: { redirect: string | undefined } = { redirect: undefined };
  const provider = createHttpXApiKeyCredentialProvider({
    fetch: async (_input, init) => {
      captured.redirect = init?.redirect;
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "exa_real_key" }),
  });

  await mediated.fetch(`${ORIGIN}/search`);

  expect(captured.redirect).toBe("manual");
});

test("also mediates a Request input, preserving its own headers", async () => {
  const captured: { apiKey: string | null } = { apiKey: null };
  const provider = createHttpXApiKeyCredentialProvider({
    fetch: async (request) => {
      captured.apiKey = (request as Request).headers.get("x-api-key");
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "exa_real_key" }),
  });

  await mediated.fetch(
    new Request(`${ORIGIN}/search`, { method: "POST" }),
  );

  expect(captured.apiKey).toBe("exa_real_key");
});
