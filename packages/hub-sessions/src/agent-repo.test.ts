import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { generateKeyPair } from "@intx/crypto";
import { createDeployPack } from "@workbench/storage-isogit";
import { createAgentRepoStore, type RegisteredKindHandler } from "./agent-repo";
import type { KeyPair } from "@intx/types/runtime";
import type { KindHandler, Principal } from "./repo-store";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

let signingKey: KeyPair;

beforeAll(async () => {
  signingKey = await generateKeyPair();
});

afterAll(async () => {
  for (const d of tempDirs.splice(0)) {
    await fs.promises.rm(d, { recursive: true, force: true }).catch((_e) => {
      /* best effort cleanup */
    });
  }
});

describe("AgentRepoStore", () => {
  test("writeDeployTree creates a commit with the system prompt", async () => {
    const dataDir = await makeTempDir("agent-repo-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    const { commitSha } = await store.writeDeployTree("agent-1", {
      systemPrompt: "You are a test agent.",
    });

    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

    const repoDir = path.join(dataDir, "agents", "agent-1");
    const prompt = await fs.promises.readFile(
      path.join(repoDir, "deploy", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toBe("You are a test agent.");

    const ref = await git.resolveRef({
      fs,
      dir: repoDir,
      ref: "refs/heads/deploy",
    });
    expect(ref).toBe(commitSha);
  });

  test("writeDeployTree does not advance refs/heads/main", async () => {
    const dataDir = await makeTempDir("agent-repo-ref-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-ref", {
      systemPrompt: "Ref test.",
    });

    const repoDir = path.join(dataDir, "agents", "agent-ref");
    const mainLog = await git.log({ fs, dir: repoDir, ref: "refs/heads/main" });
    const deployLog = await git.log({
      fs,
      dir: repoDir,
      ref: "refs/heads/deploy",
    });

    // main should only have the init commit
    expect(mainLog.length).toBe(1);
    // deploy should have 2: init parent + deploy commit
    expect(deployLog.length).toBe(2);
  });

  test("createDeployPack produces a valid packfile", async () => {
    const dataDir = await makeTempDir("agent-repo-pack-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-2", {
      systemPrompt: "Pack test.",
    });

    const { pack, commitSha, ref } = await store.createDeployPack("agent-2");

    expect(pack).toBeInstanceOf(Uint8Array);
    expect(pack.length).toBeGreaterThan(0);
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ref).toBe("refs/heads/deploy");
  });

  test("receiveAgentStatePack indexes objects and updates ref", async () => {
    const dataDir = await makeTempDir("agent-repo-state-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-3", {
      systemPrompt: "State test.",
    });

    const sourceDir = await makeTempDir("state-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.mkdir(path.join(sourceDir, "state"), { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceDir, "state", "turns.jsonl"),
      '{"messages":[]}',
    );
    await git.add({ fs, dir: sourceDir, filepath: "state/turns.jsonl" });
    const stateCommit = await git.commit({
      fs,
      dir: sourceDir,
      message: "State snapshot",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");

    const stateRef = "refs/instances/test-instance";
    await store.receiveAgentStatePack(
      { kind: "agent-state", id: "agent-3" },
      pack,
      stateRef,
      stateCommit,
    );

    const repoDir = path.join(dataDir, "agents", "agent-3");
    const resolved = await git.resolveRef({
      fs,
      dir: repoDir,
      ref: stateRef,
    });
    expect(resolved).toBe(stateCommit);
  });

  test("receiveAgentStatePack accepts packs with .gitignore alongside state", async () => {
    const dataDir = await makeTempDir("agent-repo-gitignore-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-gi", {
      systemPrompt: "Gitignore test.",
    });

    const sourceDir = await makeTempDir("gitignore-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.writeFile(path.join(sourceDir, ".gitignore"), "keys/\n");
    await fs.promises.mkdir(path.join(sourceDir, "state"), { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceDir, "state", "turns.jsonl"),
      "{}",
    );
    await git.add({ fs, dir: sourceDir, filepath: ".gitignore" });
    await git.add({ fs, dir: sourceDir, filepath: "state/turns.jsonl" });
    const stateCommit = await git.commit({
      fs,
      dir: sourceDir,
      message: "State with gitignore",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");
    const stateRef = "refs/instances/gi-test";
    await store.receiveAgentStatePack(
      { kind: "agent-state", id: "agent-gi" },
      pack,
      stateRef,
      stateCommit,
    );

    const repoDir = path.join(dataDir, "agents", "agent-gi");
    const resolved = await git.resolveRef({
      fs,
      dir: repoDir,
      ref: stateRef,
    });
    expect(resolved).toBe(stateCommit);
  });

  test("receiveAgentStatePack rejects packs with only .gitignore and no state/", async () => {
    const dataDir = await makeTempDir("agent-repo-gitignore-only-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-gio", {
      systemPrompt: "Gitignore-only test.",
    });

    const sourceDir = await makeTempDir("gitignore-only-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.writeFile(path.join(sourceDir, ".gitignore"), "keys/\n");
    await git.add({ fs, dir: sourceDir, filepath: ".gitignore" });
    const badCommit = await git.commit({
      fs,
      dir: sourceDir,
      message: "Only gitignore",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");

    await expect(
      store.receiveAgentStatePack(
        { kind: "agent-state", id: "agent-gio" },
        pack,
        "refs/instances/test",
        badCommit,
      ),
    ).rejects.toThrow("path_violation");
  });

  test("receiveAgentStatePack rejects packs with paths outside state/", async () => {
    const dataDir = await makeTempDir("agent-repo-confined-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-confined", {
      systemPrompt: "Confinement test.",
    });

    const sourceDir = await makeTempDir("confined-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.mkdir(path.join(sourceDir, "state"), { recursive: true });
    await fs.promises.mkdir(path.join(sourceDir, "deploy"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(sourceDir, "state", "turns.jsonl"),
      "{}",
    );
    await fs.promises.writeFile(
      path.join(sourceDir, "deploy", "prompt.md"),
      "evil",
    );
    await git.add({ fs, dir: sourceDir, filepath: "state/turns.jsonl" });
    await git.add({ fs, dir: sourceDir, filepath: "deploy/prompt.md" });
    const badCommit = await git.commit({
      fs,
      dir: sourceDir,
      message: "Escaped confinement",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");

    await expect(
      store.receiveAgentStatePack(
        { kind: "agent-state", id: "agent-confined" },
        pack,
        "refs/instances/test",
        badCommit,
      ),
    ).rejects.toThrow("path_violation");
  });

  test("writeDeployTree produces a fresh commit when content changes", async () => {
    const dataDir = await makeTempDir("agent-repo-idem-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    const first = await store.writeDeployTree("agent-4", {
      systemPrompt: "Version 1",
    });

    const second = await store.writeDeployTree("agent-4", {
      systemPrompt: "Version 2",
    });

    expect(second.commitSha).not.toBe(first.commitSha);

    const repoDir = path.join(dataDir, "agents", "agent-4");
    const prompt = await fs.promises.readFile(
      path.join(repoDir, "deploy", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toBe("Version 2");
  });

  test("hub repo does not contain state/ scaffolding", async () => {
    const dataDir = await makeTempDir("agent-repo-nostate-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await store.writeDeployTree("agent-5", {
      systemPrompt: "No state test.",
    });

    const repoDir = path.join(dataDir, "agents", "agent-5");
    const stateExists = await fs.promises
      .stat(path.join(repoDir, "state"))
      .then(() => true)
      .catch(() => false);
    expect(stateExists).toBe(false);
  });

  test("receiveWorkflowRunPack indexes a workflow-run genesis pack and updates the ref", async () => {
    const dataDir = await makeTempDir("agent-repo-wfr-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    // Construct a workflow-run pack carrying a `.gitignore`-only
    // genesis tree (the workflow-run kind handler explicitly accepts
    // this as the initial commit so deploy-time init can land before
    // any run produces an event).
    const sourceDir = await makeTempDir("wfr-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.writeFile(path.join(sourceDir, ".gitignore"), "");
    await git.add({ fs, dir: sourceDir, filepath: ".gitignore" });
    const wfrCommit = await git.commit({
      fs,
      dir: sourceDir,
      message: "Workflow-run genesis",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");

    const wfrRef = "refs/heads/events";
    const deploymentId = "dep-wfr-happy";
    await store.receiveWorkflowRunPack(
      { kind: "workflow-run", id: deploymentId },
      pack,
      wfrRef,
      wfrCommit,
    );

    const repoDir = path.join(dataDir, "workflow-runs", deploymentId);
    const resolved = await git.resolveRef({
      fs,
      dir: repoDir,
      ref: wfrRef,
    });
    expect(resolved).toBe(wfrCommit);
  });

  test("receiveWorkflowRunPack rejects packs whose repoId.kind is not workflow-run", async () => {
    const dataDir = await makeTempDir("agent-repo-wfr-wrong-kind-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    const sourceDir = await makeTempDir("wfr-wrong-kind-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.writeFile(path.join(sourceDir, ".gitignore"), "");
    await git.add({ fs, dir: sourceDir, filepath: ".gitignore" });
    const commit = await git.commit({
      fs,
      dir: sourceDir,
      message: "Wrong kind",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");

    await expect(
      store.receiveWorkflowRunPack(
        { kind: "agent-state", id: "agent-x" },
        pack,
        "refs/heads/events",
        commit,
      ),
    ).rejects.toThrow(
      /receiveWorkflowRunPack requires repoId\.kind === "workflow-run"/,
    );
  });

  test("receiveAgentStatePack rejects packs whose repoId.kind is not agent-state", async () => {
    const dataDir = await makeTempDir("agent-repo-state-wrong-kind-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    const sourceDir = await makeTempDir("state-wrong-kind-source-");
    await git.init({ fs, dir: sourceDir, defaultBranch: "main" });
    await fs.promises.mkdir(path.join(sourceDir, "state"), { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceDir, "state", "turns.jsonl"),
      "{}",
    );
    await git.add({ fs, dir: sourceDir, filepath: "state/turns.jsonl" });
    const commit = await git.commit({
      fs,
      dir: sourceDir,
      message: "Misrouted",
      author: { name: "test", email: "test@test" },
    });

    const { pack } = await createDeployPack(sourceDir, "refs/heads/main");

    await expect(
      store.receiveAgentStatePack(
        { kind: "workflow-run", id: "dep-misrouted" },
        pack,
        "refs/heads/state",
        commit,
      ),
    ).rejects.toThrow(
      /receiveAgentStatePack requires repoId\.kind === "agent-state"/,
    );
  });

  test("rejects agent IDs with path traversal characters", () => {
    const dataDir = "/tmp/never-created";
    const store = createAgentRepoStore({ dataDir, signingKey });

    expect(() =>
      store.writeDeployTree("../../evil", {
        systemPrompt: "x",
      }),
    ).toThrow("repo_id_invalid: ../../evil");

    expect(() =>
      store.writeDeployTree("agent@domain", {
        systemPrompt: "x",
      }),
    ).toThrow("repo_id_invalid: agent@domain");
  });
});

// WORKBENCH-LOCAL (CL-4231): the kind seam. `createAgentRepoStore`'s
// `handlers` option registers an additional kind, merged with the five
// built-ins, so a caller can add an asset kind without editing this
// package. These tests demonstrate the seam end to end: the custom kind
// gets a real on-disk git repo (its own `directoryPrefix`), its content is
// gated by a real pre-commit `validatePush` tree check (not an
// identity-only DB row), and it shows up in `AgentRepoStore.registeredKinds`
// alongside the built-ins.
describe("createAgentRepoStore custom kind handler (CL-4231)", () => {
  const NOTE_HUB: Principal = { kind: "hub" };

  function makeNoteHandler(): RegisteredKindHandler {
    const handler: KindHandler = {
      kind: "note",
      directoryPrefix: "assets/note",
      validatePush: ({ readBlob, topLevelTreePaths }) => {
        if (!topLevelTreePaths.includes("NOTE.md")) {
          return { ok: false, reason: "note repo must contain NOTE.md" };
        }
        return (async () => {
          const bytes = await readBlob("NOTE.md");
          if (new TextDecoder().decode(bytes).trim().length === 0) {
            return { ok: false, reason: "NOTE.md must not be empty" };
          }
          return { ok: true };
        })();
      },
      onRefUpdated: () => {
        /* no side effects needed for the test double */
      },
    };
    const authorize: RegisteredKindHandler["authorize"] = (
      principal,
      _repoId,
      _ref,
      _action,
    ) => {
      if (principal.kind !== "hub") {
        return { allowed: false, reason: "only the hub may write note repos" };
      }
      return { allowed: true };
    };
    return { handler, authorize };
  }

  test("registeredKinds includes the five built-ins plus the custom kind", async () => {
    const dataDir = await makeTempDir("agent-repo-custom-kind-");
    const store = createAgentRepoStore({
      dataDir,
      signingKey,
      handlers: { note: makeNoteHandler() },
    });

    expect([...store.registeredKinds].sort()).toEqual(
      [
        "agent-state",
        "note",
        "package-registry",
        "skill",
        "workflow",
        "workflow-run",
      ].sort(),
    );
  });

  test("a caller-registered kind colliding with a built-in throws at construction", async () => {
    const dataDir = await makeTempDir("agent-repo-custom-kind-collision-");
    expect(() =>
      createAgentRepoStore({
        dataDir,
        signingKey,
        handlers: { skill: makeNoteHandler() },
      }),
    ).toThrow(/collides with a built-in kind/);
  });

  test("a caller-registered kind whose directoryPrefix collides with a built-in's throws at construction", async () => {
    const dataDir = await makeTempDir(
      "agent-repo-custom-kind-prefix-collision-",
    );
    const collidingHandler = makeNoteHandler();
    collidingHandler.handler = {
      ...collidingHandler.handler,
      // "skill"'s built-in handler owns this directoryPrefix; registering
      // a different kind name under the same prefix must still throw,
      // since two kinds writing to the same on-disk prefix would
      // silently overwrite each other's repos.
      directoryPrefix: "assets/skill",
    };
    expect(() =>
      createAgentRepoStore({
        dataDir,
        signingKey,
        handlers: { note: collidingHandler },
      }),
    ).toThrow(/directoryPrefix.*collides with kind "skill"/);
  });

  test("two caller-registered kinds sharing a directoryPrefix throw at construction", async () => {
    const dataDir = await makeTempDir(
      "agent-repo-custom-kinds-mutual-prefix-collision-",
    );
    const noteHandler = makeNoteHandler();
    const otherHandler = makeNoteHandler();
    otherHandler.handler = {
      ...otherHandler.handler,
      kind: "memo",
      directoryPrefix: "assets/note",
    };
    expect(() =>
      createAgentRepoStore({
        dataDir,
        signingKey,
        handlers: { note: noteHandler, memo: otherHandler },
      }),
    ).toThrow(/directoryPrefix.*collides with kind "note"/);
  });

  test("writing valid content to the custom kind produces a real git-backed commit", async () => {
    const dataDir = await makeTempDir("agent-repo-custom-kind-write-");
    const store = createAgentRepoStore({
      dataDir,
      signingKey,
      handlers: { note: makeNoteHandler() },
    });

    const { commitSha } = await store.repoStore.writeTree(
      NOTE_HUB,
      { kind: "note", id: "note-1" },
      "refs/heads/main",
      { files: { "NOTE.md": "hello from a custom kind" }, message: "init" },
    );
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Real git-backed content: the repo lives under the handler's own
    // directoryPrefix, and the committed blob round-trips through git.
    const dir = store.repoStore.getRepoDir({ kind: "note", id: "note-1" });
    expect(dir).toContain(path.join("assets", "note"));
    const sha = await git.resolveRef({ fs, dir, ref: "refs/heads/main" });
    expect(sha).toBe(commitSha);
    const { commit } = await git.readCommit({ fs, dir, oid: sha });
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: commit.tree,
      filepath: "NOTE.md",
    });
    expect(new TextDecoder().decode(blob)).toBe("hello from a custom kind");
  });

  test("the custom kind's validatePush rejects content that fails its own rule", async () => {
    const dataDir = await makeTempDir("agent-repo-custom-kind-reject-");
    const store = createAgentRepoStore({
      dataDir,
      signingKey,
      handlers: { note: makeNoteHandler() },
    });

    await expect(
      store.repoStore.writeTree(
        NOTE_HUB,
        { kind: "note", id: "note-2" },
        "refs/heads/main",
        { files: { "NOTE.md": "" }, message: "init" },
      ),
    ).rejects.toThrow(/path_violation:.*NOTE\.md must not be empty/);
  });

  test("the custom kind's authorize gate denies a non-hub principal", async () => {
    const dataDir = await makeTempDir("agent-repo-custom-kind-authz-");
    const store = createAgentRepoStore({
      dataDir,
      signingKey,
      handlers: { note: makeNoteHandler() },
    });

    await expect(
      store.repoStore.writeTree(
        { kind: "sidecar" },
        { kind: "note", id: "note-3" },
        "refs/heads/main",
        { files: { "NOTE.md": "nope" }, message: "init" },
      ),
    ).rejects.toThrow(/authorize_denied: only the hub may write note repos/);
  });

  test("an unregistered kind is rejected by authorize instead of silently accepted", async () => {
    const dataDir = await makeTempDir("agent-repo-unregistered-kind-");
    const store = createAgentRepoStore({ dataDir, signingKey });

    await expect(
      store.repoStore.writeTree(
        NOTE_HUB,
        { kind: "note", id: "note-4" },
        "refs/heads/main",
        { files: { "NOTE.md": "x" }, message: "init" },
      ),
    ).rejects.toThrow(
      /authorize_denied: no authorize registered for kind: note/,
    );
  });
});
