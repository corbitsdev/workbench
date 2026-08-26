import { expect, test } from "bun:test";

import {
  createHttpXManusApiKeyCredentialProvider,
  HTTP_X_MANUS_API_KEY_PROVIDER_KEY,
} from "./http-x-manus-api-key-provider";

const ORIGIN = "https://api.manus.ai";

function materialSource(secret: string): { current: string } {
  return { current: secret };
}

test("key is http-x-manus-api-key", () => {
  expect(createHttpXManusApiKeyCredentialProvider().key).toBe(
    HTTP_X_MANUS_API_KEY_PROVIDER_KEY,
  );
});

test("sends the secret in x-manus-api-key, not authorization or x-api-key", async () => {
  const captured: {
    manusKey: string | null;
    apiKey: string | null;
    auth: string | null;
  } = {
    manusKey: null,
    apiKey: null,
    auth: null,
  };
  const provider = createHttpXManusApiKeyCredentialProvider({
    fetch: async (_input, init) => {
      const headers = init?.headers as Headers | undefined;
      captured.manusKey = headers?.get("x-manus-api-key") ?? null;
      captured.apiKey = headers?.get("x-api-key") ?? null;
      captured.auth = headers?.get("authorization") ?? null;
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "manus_real_key" }),
  });

  await mediated.fetch(`${ORIGIN}/v2/skill.list`);

  expect(captured.manusKey).toBe("manus_real_key");
  expect(captured.apiKey).toBeNull();
  expect(captured.auth).toBeNull();
});

test("re-reads the material source per call, reflecting a rotation", async () => {
  const manusKeys: string[] = [];
  const material = materialSource("original-key");
  const provider = createHttpXManusApiKeyCredentialProvider({
    fetch: async (_input, init) => {
      manusKeys.push(
        (init?.headers as Headers | undefined)?.get("x-manus-api-key") ?? "",
      );
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: material.current }),
  });

  await mediated.fetch(`${ORIGIN}/v2/skill.list`);
  material.current = "rotated-key";
  await mediated.fetch(`${ORIGIN}/v2/skill.list`);

  expect(manusKeys).toEqual(["original-key", "rotated-key"]);
});

test("refuses a cross-origin request rather than leaking the secret off the pinned origin", async () => {
  const provider = createHttpXManusApiKeyCredentialProvider({
    fetch: async () => new Response("{}", { status: 200 }),
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "manus_real_key" }),
  });

  await expect(
    mediated.fetch("https://evil.example.com/v2/skill.list"),
  ).rejects.toThrow(/refusing cross-origin request/);
});

test("forces redirect: manual so a same-origin 3xx never auto-follows off the handle", async () => {
  const captured: { redirect: string | undefined } = { redirect: undefined };
  const provider = createHttpXManusApiKeyCredentialProvider({
    fetch: async (_input, init) => {
      captured.redirect = init?.redirect;
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "manus_real_key" }),
  });

  await mediated.fetch(`${ORIGIN}/v2/skill.list`);

  expect(captured.redirect).toBe("manual");
});

test("also mediates a Request input, preserving its own headers", async () => {
  const captured: { manusKey: string | null } = { manusKey: null };
  const provider = createHttpXManusApiKeyCredentialProvider({
    fetch: async (request) => {
      captured.manusKey = (request as Request).headers.get("x-manus-api-key");
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "manus_real_key" }),
  });

  await mediated.fetch(
    new Request(`${ORIGIN}/v2/task.create`, { method: "POST" }),
  );

  expect(captured.manusKey).toBe("manus_real_key");
});
