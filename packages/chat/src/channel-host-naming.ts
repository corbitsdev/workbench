// The naming contract for channel-host workflow definitions, shared
// between the server-side platform adapter (which mints the names) and
// any UI that lists workflow runs (which must keep the chat anchor
// machinery's runs out of user-facing listings). Browser-safe on
// purpose: no platform imports, so a web bundle can consume it via the
// `@corbits/chat/channel-host-naming` subpath without dragging the
// server surface in.

/**
 * Asset names are constrained to `^[a-z0-9]+(-[a-z0-9]+)*$`; a channel
 * id (`generateId("instance")`) may carry characters outside that set,
 * so this derives a compliant name deterministically rather than
 * storing a second identifier. The workflow definition folded over the
 * asset inherits this name verbatim (see `@intx/hub-sessions`'s
 * `ensureWorkflowDefinitionForAsset`), which is what makes the name a
 * reliable discriminator for channel-host runs.
 */
export function channelHostAssetName(channelId: string): string {
  return channelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Every channel host's asset is named via `channelHostAssetName` off a
 * generated channel id: `POST /channels` mints `generateId("workflowRun")`
 * (`run_<32 hex>`), and older channels carry `generateId("instance")`
 * (`ins_<32 hex>`). Slugified, both become `<prefix>-<32 hex>` — the
 * exact shape this matcher recognizes. The platform adapter uses it to
 * exclude channel hosts from the invitable set, and workflow listings
 * use it to exclude the anchor machinery's runs — no separate "is this
 * a channel host" column needed anywhere. Requiring the full 32-hex
 * body keeps user-authored names like `run-my-report` out of the match.
 */
const CHANNEL_HOST_DEFINITION_NAME = /^(?:ins|run)-[0-9a-f]{32}$/;

/** Whether a workflow definition name belongs to a channel-host anchor
 * rather than a purpose-run workflow. */
export function isChannelHostDefinitionName(definitionName: string): boolean {
  return CHANNEL_HOST_DEFINITION_NAME.test(definitionName);
}
