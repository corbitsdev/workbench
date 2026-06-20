FROM oven/bun:1.3.14
WORKDIR /app

# Clone interchange at the PINNED commit (keep in sync with the submodule SHA in
# the repo root) so the bun-install layer below matches our pin + lockfile rather
# than floating `main`, which drifts and breaks --frozen-lockfile.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    git clone --filter=blob:none --no-checkout \
      https://github.com/faremeter/interchange.git interchange && \
    git -C interchange checkout 9e2811dd6567435054704f533e6466a8338f3525

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
COPY packages/chat/package.json packages/chat/
COPY packages/client/package.json packages/client/
COPY packages/context-repair/package.json packages/context-repair/
COPY packages/event-collector/package.json packages/event-collector/
COPY packages/gtm-workflows/package.json packages/gtm-workflows/
COPY packages/last30days-core/package.json packages/last30days-core/
COPY packages/prompts/package.json packages/prompts/
COPY packages/sentry/package.json packages/sentry/
COPY packages/settings/package.json packages/settings/
COPY packages/tool-credentials/package.json packages/tool-credentials/
COPY packages/tools-agents/package.json packages/tools-agents/
COPY packages/tools-artifact/package.json packages/tools-artifact/
COPY packages/tools-bluesky/package.json packages/tools-bluesky/
COPY packages/tools-dispatch/package.json packages/tools-dispatch/
COPY packages/tools-exa/package.json packages/tools-exa/
COPY packages/tools-firecrawl/package.json packages/tools-firecrawl/
COPY packages/tools-gamma/package.json packages/tools-gamma/
COPY packages/tools-github/package.json packages/tools-github/
COPY packages/tools-granola/package.json packages/tools-granola/
COPY packages/tools-hackernews/package.json packages/tools-hackernews/
COPY packages/tools-last30days/package.json packages/tools-last30days/
COPY packages/tools-polymarket/package.json packages/tools-polymarket/
COPY packages/tools-reddit/package.json packages/tools-reddit/
COPY packages/tools-scrapecreators/package.json packages/tools-scrapecreators/
COPY packages/tools-x/package.json packages/tools-x/
COPY packages/tools-youtube/package.json packages/tools-youtube/
COPY packages/transcript/package.json packages/transcript/
COPY packages/ui/package.json packages/ui/
COPY packages/workbench-shared/package.json packages/workbench-shared/
COPY packages/workflow/package.json packages/workflow/
COPY workflows/ab-compare/package.json workflows/ab-compare/
COPY workflows/collateral-generation/package.json workflows/collateral-generation/
COPY workflows/presentation-generation/package.json workflows/presentation-generation/
COPY workflows/reddit-opportunity-scanner/package.json workflows/reddit-opportunity-scanner/
COPY workflows/resource-enrichment/package.json workflows/resource-enrichment/
COPY workflows/seo-enrichment/package.json workflows/seo-enrichment/
RUN bun install --frozen-lockfile

# Full source for the sidecar's runtime closure ONLY. Tool packages reach the
# sidecar as registry tarballs at launch (the package-registry substrate), so no
# `@workbench/tools-*` source ships in this image.
COPY interchange/ interchange/
COPY apps/sidecar/ apps/sidecar/
COPY packages/agents/ packages/agents/
COPY packages/approvals/ packages/approvals/
COPY packages/context-repair/ packages/context-repair/
COPY packages/prompts/ packages/prompts/
COPY packages/sentry/ packages/sentry/
COPY packages/tool-credentials/ packages/tool-credentials/

CMD ["bun", "run", "apps/sidecar/src/index.ts"]
