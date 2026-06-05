FROM oven/bun:1.3.13 AS builder
WORKDIR /app

COPY . .

# Railway doesn't clone git submodules — shallow clone interchange
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    rm -rf interchange && \
    git clone --depth 1 --single-branch --branch v0.1.2 \
      https://github.com/faremeter/interchange.git interchange

RUN bun install

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

WORKDIR /app/apps/web
RUN bun run build

FROM caddy:2.9-alpine
COPY --from=builder /app/apps/web/dist /usr/share/caddy
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
