// Builds and publishes Myra's deployable definition entirely over stock
// routes. See `myra-source.ts` for why this is the one
// deploy-source variant that installs today.
//
// Three steps, each a stock route: ensure the `package-registry` asset
// exists (`POST /api/tenants/:id/assets`, tolerating the 409 an
// already-provisioned tenant reports); pack the built assistant
// definition as an npm-shaped tarball and PUT it in
// (`PUT /api/tenants/:id/assets/:assetId/tarballs/:filename`); hand back
// the `WorkflowDeployInput` the caller passes to `convergeNeedsList`.
// The pure offering-ids → deploy-input mapping (`buildMyraDeployInput`)
// is split out so it can be unit-tested without a fetch or a real
// gzip/tar round-trip.
import { ASSISTANT_SYSTEM_PROMPT } from "@corbits/myra/prompt";
import { ASSISTANT_TOOL_PACKAGE_PINS } from "@corbits/myra/tool-packages";
import { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID } from "@corbits/myra/workflow-ids";
import { renderWorkflowSourceTree } from "@corbits/workflows/client";
import { type } from "arktype";

import { MYRA_SOURCE_CONFIG } from "./myra-source";
import type { WorkflowDeployInput } from "./needs-list";

export class MyraDeployError extends Error {}

const AssetCreatedShape = type({ id: "string" });
const AssetListShape = type({ id: "string", name: "string" }).array();
const TarballPutShape = type({ commit: "string", integrity: "string" });

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

/** Idempotently ensures the `package-registry` asset Myra's tarball is
 * published into, mirroring `the deleted onboarding package's `ensureWorkflowAsset`
 * 409-then-list pattern. */
export async function ensureMyraSourceAsset(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const created = await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: MYRA_SOURCE_CONFIG.assetKind,
      name: MYRA_SOURCE_CONFIG.assetName,
      displayName: MYRA_SOURCE_CONFIG.displayName,
    }),
  });
  if (created.status === 201) {
    const parsed = AssetCreatedShape(await created.json());
    if (parsed instanceof type.errors) {
      throw new MyraDeployError(`Myra's source came back an unexpected shape: ${parsed.summary}`);
    }
    return parsed.id;
  }
  if (created.status !== 409) {
    throw new MyraDeployError(`preparing Myra's source failed: ${await readErrorBody(created)}`);
  }
  const listed = await fetchImpl(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=${MYRA_SOURCE_CONFIG.assetKind}&inherited=false`,
  );
  if (!listed.ok) {
    throw new MyraDeployError(
      `checking this workbench's setup failed: ${await readErrorBody(listed)}`,
    );
  }
  const parsed = AssetListShape(await listed.json());
  if (parsed instanceof type.errors) {
    throw new MyraDeployError(
      `this workbench's setup list came back an unexpected shape: ${parsed.summary}`,
    );
  }
  const existing = parsed.find((asset) => asset.name === MYRA_SOURCE_CONFIG.assetName);
  if (existing === undefined) {
    throw new MyraDeployError(
      "Myra's source reported a name conflict but is not listed on this workbench",
    );
  }
  return existing.id;
}

// -- tar/gzip: a minimal, dependency-free USTAR + gzip writer for the
// exact two small text files `renderWorkflowSourceTree` emits. No new
// package: the browser's own `CompressionStream("gzip")` does the
// compression; only the tar container needs hand-rolling. --

const TAR_BLOCK_SIZE = 512;

function tarChecksumPlaceholder(): string {
  return "        "; // 8 spaces, per the USTAR header spec
}

function padOctal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** One USTAR header block plus its content, padded to a 512-byte
 * boundary — everything `tar.Parser`'s auto-detected gzip+ustar read
 * needs for a single regular-file entry. */
function tarEntry(path: string, content: Uint8Array): Uint8Array {
  if (path.length >= 100) {
    throw new MyraDeployError(
      `tar entry path ${JSON.stringify(path)} is too long for a USTAR header`,
    );
  }
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const encoder = new TextEncoder();
  const writeField = (offset: number, value: string): void => {
    header.set(encoder.encode(value), offset);
  };
  writeField(0, path);
  writeField(100, padOctal(0o644, 8));
  writeField(108, padOctal(0, 8));
  writeField(116, padOctal(0, 8));
  writeField(124, padOctal(content.length, 12));
  writeField(136, padOctal(0, 12));
  writeField(148, tarChecksumPlaceholder());
  writeField(156, "0"); // typeflag: regular file
  writeField(257, "ustar\0");
  writeField(263, "00");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(148, padOctal(checksum, 8).slice(0, 7) + "\0 ");

  const paddedLength = Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const body = new Uint8Array(paddedLength);
  body.set(content);

  const entry = new Uint8Array(header.length + body.length);
  entry.set(header, 0);
  entry.set(body, header.length);
  return entry;
}

/** Packs a `{ path: contents }` tree (as `renderWorkflowSourceTree`
 * returns) into an npm-shaped tar archive rooted at `package/`, then
 * gzips it. */
export async function packTarball(tree: Readonly<Record<string, string>>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const entries: Uint8Array[] = [];
  for (const [path, contents] of Object.entries(tree)) {
    entries.push(tarEntry(`package/${path}`, encoder.encode(contents)));
  }
  const endOfArchive = new Uint8Array(TAR_BLOCK_SIZE * 2);
  const totalLength = entries.reduce((sum, entry) => sum + entry.length, 0) + endOfArchive.length;
  const tar = new Uint8Array(totalLength);
  let offset = 0;
  for (const entry of entries) {
    tar.set(entry, offset);
    offset += entry.length;
  }
  tar.set(endOfArchive, offset);

  const gzipStream = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gzipStream).arrayBuffer());
}

function tarballFilename(): string {
  const safeName = MYRA_SOURCE_CONFIG.packageName.replace(/[^A-Za-z0-9_.@+-]/g, "-");
  return `${safeName}-${MYRA_SOURCE_CONFIG.packageVersion}.tgz`;
}

const ASSISTANT_TURN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The exact `WorkflowDefinition` JSON `@corbits/myra`'s
 * `buildAssistantWorkflow` would produce for a single-step, mail-triggered,
 * unbounded-turn assistant — hand-built here rather than calling that
 * function, because `buildAssistantWorkflow` goes through `@intx/workflow`'s
 * `defineWorkflow`/`step`, which pull in `@intx/agent`'s Node-bound runtime
 * (file locking) that a browser bundle cannot resolve (confirmed by a failed
 * `apps/web` build importing `@corbits/myra` directly).
 * `apps/web/src/myra-deploy.test.ts` and `agents/myra`'s own
 * `validate-push.test.ts`-style round-trip both guard this shape against
 * drift from `defineWorkflow`'s own normalization
 * (`vendor/intx/workflow/src/definition/workflow.ts`'s `normalize`/
 * `applyDefaultInputStep`, and `primitives.ts`'s `step`): a single step with
 * no `after` gets `input: { from: "trigger.payload" }`; `triggers:
 * "unbounded"` (not the numeric default) gets `drainBehavior: "wait"`; a
 * bare `trigger` becomes a one-element `triggers` array.
 */
export function buildMyraDefinitionJson(triggerAddress: string): unknown {
  return {
    id: ASSISTANT_WORKFLOW_ID,
    triggers: [{ type: "mail", to: triggerAddress }],
    steps: {
      [ASSISTANT_STEP_ID]: {
        kind: "step",
        id: ASSISTANT_STEP_ID,
        agent: {
          id: ASSISTANT_STEP_ID,
          description:
            "A general-purpose assistant that answers questions, drafts " +
            "text, and reasons through problems for the team",
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          // Cosmetic label only (see `InferencePreference`'s own doc
          // comment in `@intx/agent`): deploy-time inference actually
          // resolves from the deploy's `sourceOfferingIds`, never from
          // this field.
          inference: { sources: [{ provider: "stock", model: "stock" }] },
          toolPackagePins: ASSISTANT_TOOL_PACKAGE_PINS,
        },
        drainBehavior: "wait",
        timeout: ASSISTANT_TURN_TIMEOUT_MS,
        triggers: "unbounded",
        input: { from: "trigger.payload" },
      },
    },
    stepOrder: [ASSISTANT_STEP_ID],
  };
}

/** Renders Myra's built assistant definition, packs it, and PUTs it into
 * the given `package-registry` asset. Returns the published filename
 * (`pin`'s `name@version` names the package inside it; the filename
 * itself never leaves this module). */
export async function publishMyraTarball(
  tenantId: string,
  assetId: string,
  tenantDomain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const tree = renderWorkflowSourceTree({
    packageName: MYRA_SOURCE_CONFIG.packageName,
    workflowJson: JSON.stringify(buildMyraDefinitionJson(`assistant@${tenantDomain}`)),
  });
  const tarball = await packTarball(tree);
  const filename = tarballFilename();
  const response = await fetchImpl(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(assetId)}/tarballs/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([tarball as Uint8Array<ArrayBuffer>]),
    },
  );
  if (!response.ok) {
    throw new MyraDeployError(`publishing Myra's tarball failed: ${await readErrorBody(response)}`);
  }
  const parsed = TarballPutShape(await response.json());
  if (parsed instanceof type.errors) {
    throw new MyraDeployError(
      `Myra's tarball upload came back an unexpected shape: ${parsed.summary}`,
    );
  }
}

/** The pure mapping this module exists to get right: the operator's
 * offering pick plus the asset this tenant just published into, turned
 * into the exact `WorkflowDeployInput` `convergeNeedsList` needs. Split
 * out from the fetch/tar plumbing above so it is unit-testable on its
 * own. */
export function buildMyraDeployInput(args: {
  assetId: string;
  sourceOfferingIds: readonly string[];
  defaultSourceOfferingId: string;
}): WorkflowDeployInput {
  if (args.sourceOfferingIds.length === 0) {
    throw new MyraDeployError("at least one source offering id is required to start Myra");
  }
  if (!args.sourceOfferingIds.includes(args.defaultSourceOfferingId)) {
    throw new MyraDeployError(
      "the default source offering id must be one of the supplied source offering ids",
    );
  }
  return {
    source: {
      kind: "asset",
      assetId: args.assetId,
      package: { format: "tarball" },
    },
    entry: MYRA_SOURCE_CONFIG.entryPath,
    sourceOfferingIds: [...args.sourceOfferingIds],
    defaultSourceOfferingId: args.defaultSourceOfferingId,
    pin: `${MYRA_SOURCE_CONFIG.packageName}@${MYRA_SOURCE_CONFIG.packageVersion}`,
  };
}

/** Orchestrates the three steps above and returns the `myraDeploy` input
 * ready to hand to `bootstrapClientSession`/`convergeNeedsList`. */
export async function deployMyraSource(
  args: {
    tenantId: string;
    tenantDomain: string;
    sourceOfferingIds: readonly string[];
    defaultSourceOfferingId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowDeployInput> {
  const assetId = await ensureMyraSourceAsset(args.tenantId, fetchImpl);
  await publishMyraTarball(args.tenantId, assetId, args.tenantDomain, fetchImpl);
  return buildMyraDeployInput({
    assetId,
    sourceOfferingIds: args.sourceOfferingIds,
    defaultSourceOfferingId: args.defaultSourceOfferingId,
  });
}
