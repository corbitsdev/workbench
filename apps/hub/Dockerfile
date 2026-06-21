FROM oven/bun:1.3.14
WORKDIR /app

# Clone interchange at the PINNED commit (keep in sync with the submodule SHA in
# the repo root) so the bun-install layer below matches our pin + lockfile rather
# than floating `main`, which drifts and breaks --frozen-lockfile.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    git clone --filter=blob:none --no-checkout \
      https://github.com/faremeter/interchange.git interchange && \
    git -C interchange checkout fdcbaeacd73401760fe0619f5affaabb3745aa40

# Copy only manifests so bun install caches until a package.json or lockfile changes
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
COPY packages/last30days-core/package.json packages/last30days-core/
COPY packages/openapi-arktype/package.json packages/openapi-arktype/
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
COPY workflows/ab-compare/package.json workflows/ab-compare/
COPY workflows/gamma-presentation-creator/package.json workflows/gamma-presentation-creator/
COPY workflows/pain-point-collateral/package.json workflows/pain-point-collateral/
COPY workflows/reddit-opportunity-scanner/package.json workflows/reddit-opportunity-scanner/
COPY workflows/seo-enrichment-from-image/package.json workflows/seo-enrichment-from-image/
COPY workflows/smoke-test/package.json workflows/smoke-test/
RUN bun install --frozen-lockfile

COPY interchange/ interchange/
COPY apps/hub/ apps/hub/
# Railway's pre-deploy command runs `bun run scripts/db-setup.ts` in this image
COPY scripts/ scripts/
COPY packages/agents/ packages/agents/
COPY packages/event-collector/ packages/event-collector/
COPY packages/chat/ packages/chat/
COPY packages/last30days-core/ packages/last30days-core/
COPY packages/prompts/ packages/prompts/
COPY packages/sentry/ packages/sentry/
COPY packages/tool-credentials/ packages/tool-credentials/
COPY packages/tools-agents/ packages/tools-agents/
COPY packages/tools-artifact/ packages/tools-artifact/
COPY packages/tools-bluesky/ packages/tools-bluesky/
COPY packages/tools-dispatch/ packages/tools-dispatch/
COPY packages/tools-exa/ packages/tools-exa/
COPY packages/tools-firecrawl/ packages/tools-firecrawl/
COPY packages/tools-gamma/ packages/tools-gamma/
COPY packages/tools-github/ packages/tools-github/
COPY packages/tools-granola/ packages/tools-granola/
COPY packages/tools-hackernews/ packages/tools-hackernews/
COPY packages/tools-last30days/ packages/tools-last30days/
COPY packages/tools-polymarket/ packages/tools-polymarket/
COPY packages/tools-reddit/ packages/tools-reddit/
COPY packages/tools-scrapecreators/ packages/tools-scrapecreators/
COPY packages/tools-x/ packages/tools-x/
COPY packages/tools-youtube/ packages/tools-youtube/
COPY packages/ui/ packages/ui/
COPY packages/workbench-shared/ packages/workbench-shared/

EXPOSE 4000

CMD ["bun", "run", "apps/hub/src/index.ts"]
