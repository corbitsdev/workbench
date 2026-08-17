# Build context is the REPO ROOT, not apps/sidecar: workspace deps
# (@intx/*, @corbits/*) are `workspace:*` packages resolved from source,
# so `bun install` needs the whole monorepo tree, not just this app.
#
#   docker build -f apps/sidecar/Dockerfile -t corbits-sidecar:dev .
#
# (see `bun run build:sidecar-image` in the root package.json)

FROM oven/bun:1.2 AS base
WORKDIR /repo

FROM base AS install
COPY . .
RUN bun install --frozen-lockfile

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
