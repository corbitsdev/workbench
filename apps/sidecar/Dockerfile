FROM oven/bun:1.3.14
WORKDIR /app

# Clone interchange at the PINNED commit (keep in sync with the submodule SHA in
# the repo root) so the bun-install layer below matches our pin + lockfile rather
# than floating `main`, which drifts and breaks --frozen-lockfile.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    git clone --filter=blob:none --no-checkout \
      https://github.com/faremeter/interchange.git interchange && \
    git -C interchange checkout 13fb9ace3d76f453098e7ea89af030b5d897bd4a

# Manifests for EVERY workspace member. bun.lock is workspace-global, so
# `bun install --frozen-lockfile` compares the on-disk member set against the
# lockfile and fails ("lockfile had changes") if any recorded member's manifest
# is absent — even ones the sidecar never imports. This list must therefore stay
# complete. (The full-SOURCE COPY below is the opposite: it covers only the
# sidecar's runtime closure.)
COPY package.json bun.lock ./
COPY apps/hub/package.json apps/hub/
COPY apps/sidecar/package.json apps/sidecar/
COPY apps/web/package.json apps/web/
COPY packages/agents/package.json packages/agents/
COPY packages/approvals/package.json packages/approvals/
COPY packages/artifact/package.json packages/artifact/
COPY packages/blocks/package.json packages/blocks/
COPY packages/chat/package.json packages/chat/
COPY packages/catalog/package.json packages/catalog/
COPY packages/client/package.json packages/client/
COPY packages/context-repair/package.json packages/context-repair/
COPY packages/analytics/package.json packages/analytics/
COPY packages/pricing/package.json packages/pricing/
COPY packages/event-collector/package.json packages/event-collector/
COPY packages/hub-agent/package.json packages/hub-agent/
COPY packages/storage-isogit/package.json packages/storage-isogit/
COPY packages/last30days-core/package.json packages/last30days-core/
COPY packages/myra/package.json packages/myra/
COPY packages/openapi-arktype/package.json packages/openapi-arktype/
COPY packages/prompts/package.json packages/prompts/
COPY packages/sentry/package.json packages/sentry/
COPY packages/settings/package.json packages/settings/
COPY packages/timeline/package.json packages/timeline/
COPY packages/tool-credentials/package.json packages/tool-credentials/
COPY packages/tool-manifest/package.json packages/tool-manifest/
COPY packages/tools-agents/package.json packages/tools-agents/
COPY packages/tools-artifact/package.json packages/tools-artifact/
COPY packages/tools-bluesky/package.json packages/tools-bluesky/
COPY packages/tools-dispatch/package.json packages/tools-dispatch/
COPY packages/tools-exa/package.json packages/tools-exa/
COPY packages/tools-fileparser/package.json packages/tools-fileparser/
COPY packages/tools-firecrawl/package.json packages/tools-firecrawl/
COPY packages/tools-gamma/package.json packages/tools-gamma/
COPY packages/tools-linear/package.json packages/tools-linear/
COPY packages/tools-vercel/package.json packages/tools-vercel/
COPY packages/ab-compare-presets/package.json packages/ab-compare-presets/
COPY packages/tools-ab-compare/package.json packages/tools-ab-compare/
COPY packages/tools-attio/package.json packages/tools-attio/
COPY packages/tools-notion/package.json packages/tools-notion/
COPY packages/tools-catalog/package.json packages/tools-catalog/
COPY packages/tools-github/package.json packages/tools-github/
COPY packages/tools-granola/package.json packages/tools-granola/
COPY packages/tools-hackernews/package.json packages/tools-hackernews/
COPY packages/tools-last30days/package.json packages/tools-last30days/
COPY packages/tools-polymarket/package.json packages/tools-polymarket/
COPY packages/tools-reddit/package.json packages/tools-reddit/
COPY packages/tools-scrapecreators/package.json packages/tools-scrapecreators/
COPY packages/tools-skills/package.json packages/tools-skills/
COPY packages/tools-slack/package.json packages/tools-slack/
COPY packages/tools-sumble/package.json packages/tools-sumble/
COPY packages/tools-workflows/package.json packages/tools-workflows/
COPY packages/tools-x/package.json packages/tools-x/
COPY packages/tools-youtube/package.json packages/tools-youtube/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/tools-interchange-contract/package.json packages/tools-interchange-contract/
COPY packages/transcript/package.json packages/transcript/
COPY packages/ui/package.json packages/ui/
COPY packages/tasks/package.json packages/tasks/
COPY packages/workbench-shared/package.json packages/workbench-shared/
COPY packages/workflow-host/package.json packages/workflow-host/
COPY workflows/ab-compare-quality/package.json workflows/ab-compare-quality/
COPY workflows/ab-compare-speed/package.json workflows/ab-compare-speed/
COPY workflows/ab-compare-standard/package.json workflows/ab-compare-standard/
COPY workflows/attio-task-agent/package.json workflows/attio-task-agent/
COPY workflows/gamma-presentation-creator/package.json workflows/gamma-presentation-creator/
COPY workflows/heartbeat/package.json workflows/heartbeat/
COPY workflows/last30days-research/package.json workflows/last30days-research/
COPY workflows/pain-point-collateral/package.json workflows/pain-point-collateral/
COPY workflows/reddit-opportunity-scanner/package.json workflows/reddit-opportunity-scanner/
COPY workflows/smoke-test/package.json workflows/smoke-test/
COPY workflows/sumble-account-intel/package.json workflows/sumble-account-intel/
RUN bun install --frozen-lockfile

# Full source for the sidecar's runtime closure ONLY. Tool packages reach the
# sidecar as registry tarballs at launch (the package-registry substrate), so no
# `@workbench/tools-*` source ships in this image.
COPY interchange/ interchange/
COPY apps/sidecar/ apps/sidecar/
COPY packages/agents/ packages/agents/
COPY packages/myra/ packages/myra/
COPY packages/tools-catalog/ packages/tools-catalog/
COPY packages/approvals/ packages/approvals/
COPY packages/catalog/ packages/catalog/
COPY packages/context-repair/ packages/context-repair/
COPY packages/hub-agent/ packages/hub-agent/
COPY packages/storage-isogit/ packages/storage-isogit/
COPY packages/workflow-host/ packages/workflow-host/
COPY packages/prompts/ packages/prompts/
COPY packages/sentry/ packages/sentry/
COPY packages/tool-credentials/ packages/tool-credentials/
COPY packages/tool-manifest/ packages/tool-manifest/
COPY packages/workbench-shared/ packages/workbench-shared/

CMD ["bun", "run", "apps/sidecar/src/index.ts"]
