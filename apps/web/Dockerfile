FROM oven/bun:1.3.13 AS builder
WORKDIR /app

COPY . .

# Railway doesn't clone git submodules — shallow clone interchange
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    rm -rf interchange && \
    git clone --depth 1 --single-branch --branch main \
      https://github.com/faremeter/interchange.git interchange

RUN bun install

# VITE_API_BASE_URL is a build-time variable; set it on the web service in Railway.
ARG VITE_API_BASE_URL
RUN bun run --filter @workbench/web build
RUN ls -la /app/apps/web/dist/ || echo "DIST FOLDER NOT FOUND"
RUN find /app/apps/web/dist -type f | head -20 || echo "NO FILES IN DIST"

FROM caddy:2.11.3-alpine AS runtime

COPY --from=builder /app/apps/web/dist /usr/share/caddy
RUN ls -la /usr/share/caddy && find /usr/share/caddy -type f
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
