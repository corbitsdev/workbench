FROM oven/bun:1.3.13
WORKDIR /app

COPY . .

# Railway doesn't clone git submodules — shallow clone interchange
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    rm -rf interchange && \
    git clone --depth 1 --single-branch --branch main \
      https://github.com/faremeter/interchange.git interchange

RUN bun install

WORKDIR /app/apps/web
RUN bun run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "server.ts"]
