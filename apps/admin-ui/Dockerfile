FROM oven/bun:1.3.13 AS builder
WORKDIR /app

COPY . .

# Railway doesn't clone git submodules — shallow clone interchange
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    rm -rf interchange && \
    git clone --depth 1 --single-branch --branch cl-1529-workbench-compat \
      https://github.com/faremeter/interchange.git interchange

RUN bun install

WORKDIR /app/interchange/apps/admin-ui
RUN bunx vite build

FROM caddy:2.9-alpine
COPY --from=builder /app/interchange/apps/admin-ui/dist /usr/share/caddy
COPY apps/admin-ui/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
