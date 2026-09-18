// Reads one file out of a hub asset repo from the browser, mirroring
// `git-push.ts`'s in-memory clone but for the read side: isomorphic-git's
// own upload-pack wire (unlike its receive-pack) parses the hub's
// pkt-lines fine, so no hand-rolled wire code is needed here.
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

globalThis.Buffer ??= Buffer;

export class GitFetchError extends Error {}

const MAIN_REF = "refs/heads/main";

/** Fetches `main` and returns `filepath`'s contents as text. */
export async function fetchSourceFile(args: {
  url: string;
  token: string;
  filepath: string;
}): Promise<string> {
  const fs = new LightningFS(`workbench-fetch-${crypto.randomUUID()}`, { wipe: true });
  const dir = "/repo";
  await fs.promises.mkdir(dir);
  await git.init({ fs, dir, defaultBranch: "main" });
  try {
    await git.fetch({
      fs,
      http,
      dir,
      url: args.url,
      ref: MAIN_REF,
      // The hub's git server advertises no `shallow` capability, so a
      // depth-limited fetch is rejected outright; fetch the full branch.
      singleBranch: true,
      tags: false,
      headers: { Authorization: `Bearer ${args.token}` },
    });
    const oid = await git.resolveRef({ fs, dir, ref: "FETCH_HEAD" });
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: args.filepath });
    return new TextDecoder().decode(blob);
  } catch (cause) {
    throw new GitFetchError(cause instanceof Error ? cause.message : String(cause));
  }
}
