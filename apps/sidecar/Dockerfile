# Build context is the REPO ROOT, not apps/sidecar: workspace deps
# (@intx/*, @corbits/*) are `workspace:*` packages resolved from source,
# so `bun install` needs the whole monorepo tree, not just this app.
#
#   docker build -f apps/sidecar/Dockerfile -t corbits-sidecar:dev .
#
# (see `bun run build:sidecar-image` in the root package.json)

FROM oven/bun:1.3.9 AS base
WORKDIR /repo

FROM base AS install
COPY . .
# Scoped to the sidecar's own workspace closure: an unfiltered install
# pulls the whole monorepo's dependency graph (the web app's frontend
# stack included), which is both wasted image weight and enough memory
# pressure to OOM a small build container.
RUN bun install --frozen-lockfile --filter=@workbench/sidecar

FROM base AS runtime
RUN addgroup --system sidecar \
    && adduser --system --ingroup sidecar --home /home/sidecar sidecar \
    && mkdir -p /home/sidecar/interchange-sidecar-data \
    && chown -R sidecar:sidecar /home/sidecar
COPY --from=install /repo /repo
USER sidecar
ENV SIDECAR_DATA_DIR=/home/sidecar/interchange-sidecar-data
VOLUME ["/home/sidecar/interchange-sidecar-data"]
CMD ["bun", "apps/sidecar/src/index.ts"]
