# syntax=docker/dockerfile:1
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Pin interchange to a specific commit so this layer caches across deploys when interchange hasn't changed.
# Update both values together when pulling in new interchange changes.
# To get a new SHA256: wget -qO- https://github.com/faremeter/interchange/archive/<commit>.tar.gz | sha256sum
ARG INTERCHANGE_COMMIT=c03554f38aec306d8bedb12bd5768c88b73913ed
ARG INTERCHANGE_SHA256=7c5374bd8cd0eef9e440446474e3591e17c84ccbaafc7bbdec8e69371a85dfb2
RUN wget -qO interchange.tar.gz "https://github.com/faremeter/interchange/archive/${INTERCHANGE_COMMIT}.tar.gz" \
    && echo "${INTERCHANGE_SHA256}  interchange.tar.gz" | sha256sum -c \
    && tar -xz < interchange.tar.gz \
    && mv "interchange-${INTERCHANGE_COMMIT}" interchange \
    && rm interchange.tar.gz

COPY package.json bun.lock ./
COPY apps/hub/package.json apps/hub/
COPY apps/sidecar/package.json apps/sidecar/
COPY apps/web/package.json apps/web/
COPY packages/workbench-shared/package.json packages/workbench-shared/

RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache bun install --frozen-lockfile

COPY . .

FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

COPY --from=builder /app/interchange ./interchange
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/sidecar ./apps/sidecar
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

CMD ["bun", "run", "apps/sidecar/src/index.ts"]
