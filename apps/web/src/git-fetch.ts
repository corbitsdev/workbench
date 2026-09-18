// Reads one file out of a hub asset repo from the browser, mirroring
// `git-push.ts`'s in-memory clone but for the read side: isomorphic-git's
// own upload-pack wire (unlike its receive-pack) parses the hub's
// pkt-lines fine, so no hand-rolled wire code is needed here.
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import git, { Errors } from "isomorphic-git";
import http from "isomorphic-git/http/web";

globalThis.Buffer ??= Buffer;

export class GitFetchError extends Error {}

const MAIN_REF = "refs/heads/main";
// Where a single-branch fetch through the `origin` remote lands; isomorphic-git
// does not write FETCH_HEAD on this filesystem.
const FETCHED_MAIN_REF = "refs/remotes/origin/main";

async function cloneAndFetchMain(args: {
  url: string;
  token: string;
}): Promise<{ fs: InstanceType<typeof LightningFS>; dir: string }> {
  const fs = new LightningFS(`workbench-fetch-${crypto.randomUUID()}`, { wipe: true });
  const dir = "/repo";
  await fs.promises.mkdir(dir);
  await git.init({ fs, dir, defaultBranch: "main" });
  // isomorphic-git needs a configured remote to derive its refspec; a bare
  // `url` on a fresh repo fails with "Could not find a fetch refspec".
  await git.addRemote({ fs, dir, remote: "origin", url: args.url });
  await git.fetch({
    fs,
    http,
    dir,
    remote: "origin",
    ref: MAIN_REF,
    // The hub's git server advertises no `shallow` capability, so a
    // depth-limited fetch is rejected outright; fetch the full branch.
    singleBranch: true,
    tags: false,
    headers: { Authorization: `Bearer ${args.token}` },
  });
  return { fs, dir };
}

/** Fetches `main` and returns `filepath`'s contents as text. */
export async function fetchSourceFile(args: {
  url: string;
  token: string;
  filepath: string;
}): Promise<string> {
  try {
    const { fs, dir } = await cloneAndFetchMain(args);
    const oid = await git.resolveRef({ fs, dir, ref: FETCHED_MAIN_REF });
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: args.filepath });
    return new TextDecoder().decode(blob);
  } catch (cause) {
    throw new GitFetchError(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Fetches `main` and returns `filepath`'s contents as text, or `""` when
 * the branch has no commits yet or the file isn't in it — the two shapes
 * a freshly created, still-empty asset takes. Any other failure (auth,
 * network, a malformed repo) still throws. */
export async function fetchSourceFileOrEmpty(args: {
  url: string;
  token: string;
  filepath: string;
}): Promise<string> {
  try {
    const { fs, dir } = await cloneAndFetchMain(args);
    let oid: string;
    try {
      oid = await git.resolveRef({ fs, dir, ref: FETCHED_MAIN_REF });
    } catch (cause) {
      if (cause instanceof Errors.NotFoundError) return "";
      throw cause;
    }
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: args.filepath });
    return new TextDecoder().decode(blob);
  } catch (cause) {
    if (cause instanceof Errors.NotFoundError) return "";
    throw new GitFetchError(cause instanceof Error ? cause.message : String(cause));
  }
}
