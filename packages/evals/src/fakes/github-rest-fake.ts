// A fake GitHub REST origin for the CL-6403 seam: the hub, booted with
// `GITHUB_API_BASE_URL` pointing here, runs its `github` connector PAT
// probe (`GET /user`), the connect card's authenticated-login +
// repo-listing reads (`GET /user`, `GET /user/repos`,
// `GET /search/issues` for the per-repo open-PR count), and — through
// the stored provider origin — any run-time `@corbits/github-tools`
// call, against this process instead of `https://api.github.com`.
// Serves fixed fixture data over `Bun.serve`, mirroring
// `./mcp-fake-server.ts`'s shape: `receipts()` records every request
// so a scorer (or a debugging run) can see exactly what the fake was
// asked.
import type { FakeReceipt } from "../types.ts";

export interface GithubRestFakeRepo {
  readonly id: number;
  readonly full_name: string;
}

export interface GithubRestFakeHandle {
  readonly url: string;
  receipts(): readonly FakeReceipt[];
  stop(): void;
}

export function startGithubRestFake(
  port: number,
  fixture: {
    readonly login: string;
    readonly repos: readonly GithubRestFakeRepo[];
  },
): GithubRestFakeHandle {
  const receipts: FakeReceipt[] = [];

  const server = Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url);
      receipts.push({
        server: "github-rest",
        toolName: `${request.method} ${url.pathname}`,
        arguments: Object.fromEntries(url.searchParams.entries()),
      });
      if (request.method === "GET" && url.pathname === "/user") {
        return Response.json({ login: fixture.login });
      }
      if (request.method === "GET" && url.pathname === "/user/repos") {
        return Response.json(fixture.repos);
      }
      if (request.method === "GET" && url.pathname === "/search/issues") {
        return Response.json({ total_count: 1, items: [] });
      }
      return Response.json(
        { message: `github-rest fake has no route for ${url.pathname}` },
        { status: 404 },
      );
    },
  });

  return {
    url: `http://localhost:${String(port)}`,
    receipts: () => receipts,
    stop: () => {
      void server.stop(true);
    },
  };
}
