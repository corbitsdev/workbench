/**
 * Slack app manifest template, rendered for one deployment origin.
 *
 * Follows the `scout/slack/render-manifest.ts` pattern: the manifest
 * keeps `${WORKBENCH_PUBLIC_ORIGIN}` as a placeholder so no deployment
 * URL is committed, and `renderSlackAppManifest` is the only thing that
 * resolves it. Render once per Slack app — a local app and a deployed
 * app must be separate Slack apps, since a manifest names exactly one
 * request URL.
 *
 * Lives in `@corbits/slack-tag` (not `apps/hub`) per AGENTS.md: apps
 * stay generic, packages own the domain, and this template is entirely
 * about what workbench's Slack app needs — no operator-specific detail.
 */
const WEBHOOK_PATH = "/api/tag/slack/webhook";
const PLACEHOLDER = "${WORKBENCH_PUBLIC_ORIGIN}";

export const SLACK_APP_MANIFEST_TEMPLATE = `
display_information:
  name: Workbench
  description: Talk to your workbench agents from Slack.
  background_color: "#1a1a1a"
features:
  bot_user:
    display_name: workbench
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - groups:history
      - im:history
      - mpim:history
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    request_url: ${PLACEHOLDER}${WEBHOOK_PATH}
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
    request_url: ${PLACEHOLDER}${WEBHOOK_PATH}
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

/**
 * Slack rejects a request URL that is not https, and silently
 * misbehaves on a trailing slash (the rendered path would contain
 * `//`). Fail loudly here rather than after a human has pasted a
 * broken manifest into api.slack.com.
 */
export function validateWorkbenchPublicOrigin(raw: string): string {
  const origin = raw.trim();
  if (origin.length === 0) {
    throw new Error("WORKBENCH_PUBLIC_ORIGIN is empty");
  }
  if (origin.endsWith("/")) {
    throw new Error(
      `WORKBENCH_PUBLIC_ORIGIN must not end with a slash (got ${origin}) — ` +
        "the webhook path is appended directly",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`WORKBENCH_PUBLIC_ORIGIN is not a valid URL: ${origin}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `WORKBENCH_PUBLIC_ORIGIN must be https (got ${parsed.protocol}) — ` +
        "Slack refuses to deliver events over http",
    );
  }
  if (parsed.pathname !== "/") {
    throw new Error(
      `WORKBENCH_PUBLIC_ORIGIN must be an origin with no path (got path ${parsed.pathname})`,
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `WORKBENCH_PUBLIC_ORIGIN must have no query or fragment (got ${parsed.search}${parsed.hash})`,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function renderSlackAppManifest(origin: string): string {
  const validated = validateWorkbenchPublicOrigin(origin);
  return SLACK_APP_MANIFEST_TEMPLATE.replaceAll(PLACEHOLDER, validated).trim();
}
