// Pushes a small file tree into a hub asset repo from the browser over
// the stock git smart-HTTP route, using an in-memory filesystem.
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

// isomorphic-git reads the Node `Buffer` global; browsers do not ship one.
globalThis.Buffer ??= Buffer;

export class GitPushError extends Error {}

const COMMIT_AUTHOR = { name: "Workbench", email: "workbench@corbits.dev" };

/** Commits `tree` as the sole commit on `main` and force-pushes it to
 * `url` with the bearer token. Returns the commit sha. */
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
  const sha = await git.commit({ fs, dir, message: args.message, author: COMMIT_AUTHOR });
  const result = await git.push({
    fs,
    http,
    dir,
    url: args.url,
    ref: "main",
    remoteRef: "main",
    force: true,
    headers: { Authorization: `Bearer ${args.token}` },
  });
  if (!result.ok) {
    throw new GitPushError(`git push was refused: ${result.error ?? "unknown reason"}`);
  }
  return sha;
}
