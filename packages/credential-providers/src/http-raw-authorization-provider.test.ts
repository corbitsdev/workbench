import { expect, test } from "bun:test";

import {
  createHttpRawAuthorizationCredentialProvider,
  HTTP_RAW_AUTHORIZATION_PROVIDER_KEY,
} from "./http-raw-authorization-provider";

const ORIGIN = "https://api.linear.app";

function materialSource(secret: string): { current: string } {
  return { current: secret };
}

test("key is http-raw-authorization", () => {
  expect(createHttpRawAuthorizationCredentialProvider().key).toBe(
    HTTP_RAW_AUTHORIZATION_PROVIDER_KEY,
  );
});

test("sends the raw secret in authorization, with no Bearer prefix", async () => {
  const captured: { auth: string | null } = { auth: null };
  const provider = createHttpRawAuthorizationCredentialProvider({
    fetch: async (_input, init) => {
      captured.auth =
        (init?.headers as Headers | undefined)?.get("authorization") ?? null;
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "lin_api_key_real" }),
  });

  await mediated.fetch(`${ORIGIN}/graphql`);

  expect(captured.auth).toBe("lin_api_key_real");
  expect(captured.auth).not.toBe("Bearer lin_api_key_real");
});

test("re-reads the material source per call, reflecting a rotation", async () => {
  const auths: string[] = [];
  const material = materialSource("original-key");
  const provider = createHttpRawAuthorizationCredentialProvider({
    fetch: async (_input, init) => {
      auths.push(
        (init?.headers as Headers | undefined)?.get("authorization") ?? "",
      );
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: material.current }),
  });

  await mediated.fetch(`${ORIGIN}/graphql`);
  material.current = "rotated-key";
  await mediated.fetch(`${ORIGIN}/graphql`);

  expect(auths).toEqual(["original-key", "rotated-key"]);
});

test("refuses a cross-origin request rather than leaking the secret off the pinned origin", async () => {
  const provider = createHttpRawAuthorizationCredentialProvider({
    fetch: async () => new Response("{}", { status: 200 }),
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "lin_api_key_real" }),
  });

  await expect(
    mediated.fetch("https://evil.example.com/graphql"),
  ).rejects.toThrow(/refusing cross-origin request/);
});

test("forces redirect: manual so a same-origin 3xx never auto-follows off the handle", async () => {
  const captured: { redirect: string | undefined } = { redirect: undefined };
  const provider = createHttpRawAuthorizationCredentialProvider({
    fetch: async (_input, init) => {
      captured.redirect = init?.redirect;
      return new Response("{}", { status: 200 });
    },
  });
  const mediated = provider.shape({
    origin: ORIGIN,
    readCurrentMaterial: () => ({ secret: "lin_api_key_real" }),
  });

  await mediated.fetch(`${ORIGIN}/graphql`);

  expect(captured.redirect).toBe("manual");
});
