FROM oven/bun:1.2 AS builder

WORKDIR /app

# Clone interchange as HTTPS (public repo, avoids SSH key requirement)
RUN git clone --depth=1 https://github.com/faremeter/interchange.git interchange

# Copy workspace manifests for dependency install layer caching
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/workbench-shared/package.json packages/workbench-shared/

RUN bun install --frozen-lockfile

# Copy full source
COPY . .

RUN bun run --filter @gtm/api build

FROM oven/bun:1.2-slim AS runtime

WORKDIR /app

COPY --from=builder /app/interchange ./interchange
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/apps/api/migrations ./apps/api/migrations

EXPOSE 4000

CMD ["bun", "run", "apps/api/dist/index.js"]
