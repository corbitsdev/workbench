FROM oven/bun:1.3.14
WORKDIR /app

# Clone interchange at the PINNED commit (keep in sync with the submodule SHA in
# the repo root) so the bun-install layer below matches our pin + lockfile rather
# than floating `main`, which drifts and breaks --frozen-lockfile.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    git clone --filter=blob:none --no-checkout \
      https://github.com/faremeter/interchange.git interchange && \
    git -C interchange checkout 8f67b7c85ed5d6fe68880879f7a31209bb5bd4e2

# Copy only manifests so bun install caches until a package.json or lockfile
# changes. This list is the sidecar's transitive @workbench/* closure ONLY —
# tool packages reach the sidecar as registry tarballs at launch (the
# package-registry substrate), so no `@workbench/tools-*` and no `apps/hub` are
# installed here. `bun install --frozen-lockfile` only requires manifests for
# members in the resolved graph, so anything outside the closure is omitted.
COPY package.json bun.lock ./
COPY apps/sidecar/package.json apps/sidecar/
COPY packages/agents/package.json packages/agents/
COPY packages/approvals/package.json packages/approvals/
COPY packages/chat/package.json packages/chat/
COPY packages/context-repair/package.json packages/context-repair/
COPY packages/prompts/package.json packages/prompts/
COPY packages/sentry/package.json packages/sentry/
COPY packages/tool-credentials/package.json packages/tool-credentials/
COPY packages/ui/package.json packages/ui/
COPY packages/workbench-shared/package.json packages/workbench-shared/
RUN bun install --frozen-lockfile

COPY interchange/ interchange/
COPY apps/sidecar/ apps/sidecar/
COPY packages/agents/ packages/agents/
COPY packages/approvals/ packages/approvals/
COPY packages/context-repair/ packages/context-repair/
COPY packages/prompts/ packages/prompts/
COPY packages/sentry/ packages/sentry/
COPY packages/tool-credentials/ packages/tool-credentials/

CMD ["bun", "run", "apps/sidecar/src/index.ts"]
