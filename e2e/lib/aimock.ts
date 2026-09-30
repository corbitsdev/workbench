// The e2e stand-in for the inference provider: one aimock server that answers
// every model request with a fixed reply, so a bench's worker can respond with
// no real provider key. Same lifecycle shape as `bootHub`.
import { afterAll, beforeAll } from "bun:test";
import { LLMock } from "@copilotkit/aimock";

export type Fixture = Parameters<LLMock["addFixture"]>[0];

export const MOCK_REPLY = "Hey there, I'm your new co-worker. I'll go by Ada here.";

export type BootedAimock = {
  /** Origin the mock listens on, e.g. http://127.0.0.1:41234. */
  url: string;
  /** Every request the mock has served, oldest first. */
  journal: () => { method: string; path: string; body: unknown }[];
};

/** Call synchronously inside the describe body so teardown registers during collection. */
export function bootAimock(fixtures: Fixture[] = []): () => BootedAimock {
  const mock = new LLMock({ port: 0, host: "127.0.0.1" });
  // Registered before the catch-all so a scripted turn wins over the default reply.
  for (const fixture of fixtures) mock.addFixture(fixture);
  mock.addFixture({ match: { predicate: () => true }, response: { content: MOCK_REPLY } });

  beforeAll(async () => {
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  return () => ({
    url: mock.url,
    journal: () =>
      mock.getRequests().map((r) => ({ method: r.method, path: r.path, body: r.body as unknown })),
  });
}
