FROM oven/bun:1.3.13
WORKDIR /app

COPY . .

# Railway doesn't clone git submodules — shallow clone interchange
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* && \
    rm -rf interchange && \
    git clone --depth 1 --single-branch --branch main \
      https://github.com/faremeter/interchange.git interchange

RUN bun install
RUN bun run --filter @workbench/hub build

EXPOSE 4000

CMD ["bun", "run", "apps/hub/dist/index.js"]
