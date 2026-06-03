FROM oven/bun:1.3.13 AS builder
WORKDIR /app

ARG VITE_API_BASE_URL=http://localhost:4000

COPY . .

# Railway doesn't clone git submodules — shallow clone interchange
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    rm -rf interchange && \
    git clone --depth 1 --single-branch --branch main \
      https://github.com/faremeter/interchange.git interchange

RUN bun install

RUN VITE_API_BASE_URL=$VITE_API_BASE_URL bun run --filter @workbench/web build

FROM nginx:1.27-alpine

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
