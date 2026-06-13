FROM oven/bun:1.3.13
WORKDIR /app

# Install git and clone interchange before any COPY — this layer caches until the Dockerfile changes
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    git clone --depth 1 --single-branch --branch cl-1529-workbench-compat \
      https://github.com/faremeter/interchange.git interchange

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
COPY packages/gtm-workflows/package.json packages/gtm-workflows/
COPY packages/last30days-core/package.json packages/last30days-core/
COPY packages/prompts/package.json packages/prompts/
COPY packages/sentry/package.json packages/sentry/
COPY packages/settings/package.json packages/settings/
COPY packages/tool-agent/package.json packages/tool-agent/
COPY packages/tool-template/package.json packages/tool-template/
COPY packages/tools-agents/package.json packages/tools-agents/
COPY packages/tools-browser/package.json packages/tools-browser/
COPY packages/tools-dispatch/package.json packages/tools-dispatch/
COPY packages/tools-exa/package.json packages/tools-exa/
COPY packages/tools-firecrawl/package.json packages/tools-firecrawl/
COPY packages/tools-gamma/package.json packages/tools-gamma/
COPY packages/tools-github/package.json packages/tools-github/
COPY packages/tools-granola/package.json packages/tools-granola/
COPY packages/tools-hackernews/package.json packages/tools-hackernews/
COPY packages/tools-polymarket/package.json packages/tools-polymarket/
COPY packages/tools-reddit/package.json packages/tools-reddit/
COPY packages/tools-scrapecreators/package.json packages/tools-scrapecreators/
COPY packages/tools-x/package.json packages/tools-x/
COPY packages/transcript/package.json packages/transcript/
COPY packages/ui/package.json packages/ui/
COPY packages/workbench-shared/package.json packages/workbench-shared/
COPY packages/workflow-core/package.json packages/workflow-core/
COPY packages/workflow/package.json packages/workflow/
RUN bun install --frozen-lockfile

COPY interchange/ interchange/
COPY apps/hub/ apps/hub/
# Railway's pre-deploy command runs `bun run scripts/db-setup.ts` in this image
COPY scripts/ scripts/
COPY packages/agents/ packages/agents/
COPY packages/event-collector/ packages/event-collector/
COPY packages/chat/ packages/chat/
COPY packages/gtm-workflows/ packages/gtm-workflows/
COPY packages/last30days-core/ packages/last30days-core/
COPY packages/prompts/ packages/prompts/
COPY packages/sentry/ packages/sentry/
COPY packages/tools-agents/ packages/tools-agents/
COPY packages/tools-browser/ packages/tools-browser/
COPY packages/tools-dispatch/ packages/tools-dispatch/
COPY packages/tools-exa/ packages/tools-exa/
COPY packages/tools-firecrawl/ packages/tools-firecrawl/
COPY packages/tools-gamma/ packages/tools-gamma/
COPY packages/tools-github/ packages/tools-github/
COPY packages/tools-granola/ packages/tools-granola/
COPY packages/tools-hackernews/ packages/tools-hackernews/
COPY packages/tools-polymarket/ packages/tools-polymarket/
COPY packages/tools-reddit/ packages/tools-reddit/
COPY packages/tools-scrapecreators/ packages/tools-scrapecreators/
COPY packages/tools-x/ packages/tools-x/
COPY packages/ui/ packages/ui/
COPY packages/workbench-shared/ packages/workbench-shared/
COPY packages/workflow-core/ packages/workflow-core/

EXPOSE 4000

CMD ["bun", "run", "apps/hub/src/index.ts"]
