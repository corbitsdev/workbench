# syntax=docker/dockerfile:1
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Pin interchange to a specific commit so this layer caches across deploys when interchange hasn't changed.
# Required because the root workspace graph references interchange/packages/*; a frozen install
# fails if those workspace members are missing. Update together with the other app Dockerfiles.
# To get a new SHA256: wget -qO- https://github.com/faremeter/interchange/archive/<commit>.tar.gz | sha256sum
ARG INTERCHANGE_COMMIT=6d61cd63eb8a966ab8d769e9038eedd89175f5bb
ARG INTERCHANGE_SHA256=bd1515764796e3331b36903e801039c0a6c836e673200399b219e10c8cd863e3
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

RUN bun install --frozen-lockfile

COPY . .

# VITE_API_BASE_URL is a build-time variable; set it on the web service in Railway.
ARG VITE_API_BASE_URL
RUN bun run --filter @workbench/web build

FROM caddy:2.11.3-alpine AS runtime

COPY --from=builder /app/apps/web/dist /usr/share/caddy
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
