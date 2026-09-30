// The receive-pack wire exchange is spoken directly because the hub
// answers `report-status` as raw pkt-lines isomorphic-git's push can't read.
// Every request goes through the caller's `fetch`, so the same code runs in
// the browser and against an in-process hub.
import { Buffer } from "buffer";
import git, { type GitHttpRequest, type GitHttpResponse, type HttpClient } from "isomorphic-git";
import { createFsFromVolume, Volume } from "memfs";

// isomorphic-git reads the Node `Buffer` global; browsers do not ship one.
globalThis.Buffer ??= Buffer;

export class GitPushError extends Error {}

// A fixed author and a caller-independent clock keep a commit's identity a
// pure function of its tree and parent.
const COMMIT_AUTHOR = { name: "Workbench", email: "workbench@corbits.dev" };
const MAIN_REF = "refs/heads/main";
const ZERO_OID = "0".repeat(40);

function pktLine(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const header = (payload.length + 4).toString(16).padStart(4, "0");
  return new Uint8Array([...new TextEncoder().encode(header), ...payload]);
}

function readPktLines(body: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
    offset += 4;
    if (Number.isNaN(length)) throw new GitPushError("malformed pkt-line header from the hub");
    if (length === 0) continue;
    lines.push(decoder.decode(body.subarray(offset, offset + length - 4)));
    offset += length - 4;
  }
  return lines;
}

async function advertisedMainSha(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
): Promise<string> {
  const response = await fetchImpl(`${url}/info/refs?service=git-receive-pack`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new GitPushError(`ref advertisement failed: HTTP ${response.status}`);
  }
  const lines = readPktLines(new Uint8Array(await response.arrayBuffer()));
  for (const line of lines) {
    const [sha, rest] = line.split(" ", 2);
    const ref = rest?.split("\0")[0]?.trim();
    if (sha !== undefined && ref === MAIN_REF) return sha;
  }
  return ZERO_OID;
}

// isomorphic-git's own web client calls the global `fetch`; this one routes
// through the caller's.
function httpThrough(fetchImpl: typeof fetch): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const chunks: Uint8Array[] = [];
      if (req.body !== undefined) for await (const chunk of req.body) chunks.push(chunk);
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const response = await fetchImpl(req.url, {
        method: req.method ?? "GET",
        headers: req.headers ?? {},
        ...(length > 0 ? { body } : {}),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        url: req.url,
        method: req.method ?? "GET",
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: (async function* () {
          yield bytes;
        })(),
      };
    },
  };
}

/** Commits `tree` on top of the asset's current `main` and pushes it.
 * When `main` already holds exactly this tree nothing is pushed and
 * `changed` is false. Returns the commit `main` points at afterwards. */
export async function pushSourceTree(args: {
  fetch: typeof fetch;
  url: string;
  token: string;
  tree: Readonly<Record<string, string>>;
  message: string;
}): Promise<{ commitSha: string; changed: boolean }> {
  const fs = createFsFromVolume(new Volume());
  const dir = "/repo";
  await fs.promises.mkdir(dir);
  await git.init({ fs, dir, defaultBranch: "main" });

  const entries = [];
  for (const [filepath, contents] of Object.entries(args.tree)) {
    if (filepath.includes("/")) {
      throw new GitPushError(`pushSourceTree writes a flat tree; got ${JSON.stringify(filepath)}`);
    }
    const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(contents) });
    entries.push({ mode: "100644", path: filepath, oid, type: "blob" as const });
  }
  const treeOid = await git.writeTree({ fs, dir, tree: entries });

  const oldSha = await advertisedMainSha(args.fetch, args.url, args.token);
  if (oldSha !== ZERO_OID) {
    await git.addRemote({ fs, dir, remote: "origin", url: args.url });
    // The hub's git server advertises no `shallow` capability, so fetch the
    // full branch.
    await git.fetch({
      fs,
      http: httpThrough(args.fetch),
      dir,
      remote: "origin",
      ref: MAIN_REF,
      singleBranch: true,
      tags: false,
      headers: { Authorization: `Bearer ${args.token}` },
    });
    const { commit: current } = await git.readCommit({ fs, dir, oid: oldSha });
    if (current.tree === treeOid) return { commitSha: oldSha, changed: false };
  }

  const sha = await git.writeCommit({
    fs,
    dir,
    commit: {
      message: args.message,
      tree: treeOid,
      parent: oldSha === ZERO_OID ? [] : [oldSha],
      author: { ...COMMIT_AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      committer: { ...COMMIT_AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
    },
  });
  const { packfile } = await git.packObjects({
    fs,
    dir,
    oids: [sha, treeOid, ...entries.map((entry) => entry.oid)],
  });
  if (packfile === undefined) throw new GitPushError("packObjects returned no packfile");

  const command = pktLine(`${oldSha} ${sha} ${MAIN_REF}\0report-status\n`);
  const body = new Uint8Array(command.length + 4 + packfile.length);
  body.set(command, 0);
  body.set(new TextEncoder().encode("0000"), command.length);
  body.set(packfile, command.length + 4);
  const response = await args.fetch(`${args.url}/git-receive-pack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "content-type": "application/x-git-receive-pack-request",
    },
    body,
  });
  if (!response.ok) {
    throw new GitPushError(`git push failed: HTTP ${response.status}`);
  }
  const report = readPktLines(new Uint8Array(await response.arrayBuffer()));
  const refusal = report.find(
    (line) => line.startsWith("ng ") || (line.startsWith("unpack ") && line.trim() !== "unpack ok"),
  );
  if (refusal !== undefined) {
    throw new GitPushError(`git push was refused: ${refusal.trim()}`);
  }
  if (!report.some((line) => line.trim() === `ok ${MAIN_REF}`)) {
    throw new GitPushError(`git push reported no result for ${MAIN_REF}`);
  }
  return { commitSha: sha, changed: true };
}
