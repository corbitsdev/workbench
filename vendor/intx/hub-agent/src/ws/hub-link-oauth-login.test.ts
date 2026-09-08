// CL-7508 review F2b: the hub link must deliver an inbound
// `oauth.login.cancel` frame to the executor's cancel handle, and a
// subsequent `oauth.login.start` must re-invoke the executor — the
// frame-to-cancel half of the abandoned-login fix. This package previously
// had no colocated tests; this one runs the real link against a local
// Bun WebSocket server so no test infrastructure outside the package is
// needed.
import { afterAll, describe, expect, test } from "bun:test";
import type { HubTransport } from "@intx/mail-memory";
import type { SessionManager } from "../session-manager";
import type { AgentKeyStore } from "../agent-key-store";
import { createHubLink, type OAuthLoginExecutor } from "./hub-link";

function stubTransport(): HubTransport {
  return {
    register() {
      return undefined;
    },
    unregister() {
      return undefined;
    },
    getTransportFor() {
      throw new Error("not used in this test");
    },
    setRemoteSendHandler() {
      return undefined;
    },
    addMessageSentHandler() {
      return undefined;
    },
    deliver() {
      return undefined;
    },
  };
}

const stubKeyStore: AgentKeyStore = {
  loadOrGenerateKey: async () => {
    throw new Error("not used in this test");
  },
  recordHubKey() {
    return undefined;
  },
  verifyDeployCommit: async () => false,
  forgetAgent() {
    return undefined;
  },
};

type ServerSocket = { send: (data: string) => void };

describe("hub-link oauth.login.cancel", () => {
  let server: ReturnType<typeof Bun.serve>;

  afterAll(() => {
    server?.stop(true);
  });

  test("an inbound cancel frame reaches the executor and a later start re-invokes it", async () => {
    const cancelled: string[] = [];
    const started: string[] = [];
    // The login the driver is currently asking for; the executor reads it
    // because the wire frame alone does not carry which login the test is
    // staging beyond its requestId (it does — this mirrors it for asserts).
    let currentRequestId = "";

    let serverSocket: ServerSocket | undefined;
    const sockets = (): ServerSocket[] =>
      serverSocket === undefined ? [] : [serverSocket];
    server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request, { data: undefined })) {
          return undefined;
        }
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(ws) {
          serverSocket = ws as unknown as ServerSocket;
        },
        message(ws, data) {
          const frame = JSON.parse(String(data)) as {
            type?: string;
            requestId?: string;
          };
          if (frame.type !== "oauth.login.start") return;
          const requestId = frame.requestId ?? "";
          ws.send(
            JSON.stringify({
              type: "oauth.login.result",
              requestId,
              outcome: {
                status: "started",
                authorizeUrl: "https://auth.example/authorize",
              },
            }),
          );
        },
      },
    });

    const executor: OAuthLoginExecutor = (connectorId) => {
      expect(connectorId).toBe("codex");
      const requestId = currentRequestId;
      started.push(requestId);
      return Promise.resolve({
        authorizeUrl: `https://auth.example/${requestId}`,
        completed: new Promise<never>(() => undefined),
        cancel: () => {
          cancelled.push(requestId);
        },
      });
    };

    const link = createHubLink({
      hubURL: `ws://localhost:${String(server.port)}`,
      sidecarId: "sc-test",
      token: "token",
      transport: stubTransport(),
      sessions: {
        initRepo: async () => undefined,
      } as unknown as SessionManager,
      keyStore: stubKeyStore,
      deployRouter: {
        deploy: async () => ({ publicKey: "a".repeat(64) }),
      },
      oauthLoginExecutor: executor,
      pingIntervalMs: 60_000,
      reconnectDelayMs: 60_000,
    });
    link.connect();

    // Give the socket time to open and the register handshake to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    async function driveLogin(requestId: string): Promise<void> {
      currentRequestId = requestId;
      for (const socket of sockets()) {
        socket.send(
          JSON.stringify({
            type: "oauth.login.start",
            requestId,
            connectorId: "codex",
          }),
        );
      }
      for (let i = 0; i < 100 && !startedRequests().includes(requestId); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    function startedRequests(): string[] {
      return [...started];
    }

    await driveLogin("req_1");
    expect(started).toEqual(["req_1"]);
    expect(cancelled).toEqual([]);

    for (const socket of sockets()) {
      socket.send(
        JSON.stringify({ type: "oauth.login.cancel", requestId: "req_1" }),
      );
    }
    for (let i = 0; i < 100 && cancelled.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cancelled).toEqual(["req_1"]);

    await driveLogin("req_2");
    expect(started).toEqual(["req_1", "req_2"]);

    link.close();
  });
});
