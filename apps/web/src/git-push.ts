// The receive-pack wire exchange is spoken directly because the hub
// answers `report-status` as raw pkt-lines isomorphic-git's push can't read.
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import git from "isomorphic-git";

// isomorphic-git reads the Node `Buffer` global; browsers do not ship one.
globalThis.Buffer ??= Buffer;

export class GitPushError extends Error {}

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

async function advertisedMainSha(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/info/refs?service=git-receive-pack`, {
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

/** Commits `tree` on top of the asset's current `main` and pushes it.
 * Returns the new commit sha. */
export async function pushSourceTree(args: {
  url: string;
  token: string;
  tree: Readonly<Record<string, string>>;
  message: string;
}): Promise<string> {
  const fs = new LightningFS(`workbench-push-${crypto.randomUUID()}`, { wipe: true });
  const dir = "/repo";
  await fs.promises.mkdir(dir);
  await git.init({ fs, dir, defaultBranch: "main" });
  for (const [filepath, contents] of Object.entries(args.tree)) {
    if (filepath.includes("/")) {
      throw new GitPushError(`pushSourceTree writes a flat tree; got ${JSON.stringify(filepath)}`);
    }
    await fs.promises.writeFile(`${dir}/${filepath}`, contents, "utf8");
    await git.add({ fs, dir, filepath });
  }
  const oldSha = await advertisedMainSha(args.url, args.token);
  const sha = await git.commit({
    fs,
    dir,
    message: args.message,
    author: COMMIT_AUTHOR,
    parent: oldSha === ZERO_OID ? [] : [oldSha],
  });
  const { commit } = await git.readCommit({ fs, dir, oid: sha });
  const { tree } = await git.readTree({ fs, dir, oid: commit.tree });
  const { packfile } = await git.packObjects({
    fs,
    dir,
    oids: [sha, commit.tree, ...tree.map((entry) => entry.oid)],
  });
  if (packfile === undefined) throw new GitPushError("packObjects returned no packfile");

  const command = pktLine(`${oldSha} ${sha} ${MAIN_REF}\0report-status\n`);
  const body = new Uint8Array(command.length + 4 + packfile.length);
  body.set(command, 0);
  body.set(new TextEncoder().encode("0000"), command.length);
  body.set(packfile, command.length + 4);
  const response = await fetch(`${args.url}/git-receive-pack`, {
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
  return sha;
}
