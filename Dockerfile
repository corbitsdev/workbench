FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Pin interchange to a specific commit so this layer caches across deploys when interchange hasn't changed.
# Update both values together when pulling in new interchange changes.
# To get a new SHA256: curl -fsSL https://github.com/faremeter/interchange/archive/<commit>.tar.gz | sha256sum
ARG INTERCHANGE_COMMIT=6d61cd63eb8a966ab8d769e9038eedd89175f5bb
ARG INTERCHANGE_SHA256=bd1515764796e3331b36903e801039c0a6c836e673200399b219e10c8cd863e3
RUN curl -fsSL "https://github.com/faremeter/interchange/archive/${INTERCHANGE_COMMIT}.tar.gz" -o interchange.tar.gz \
    && echo "${INTERCHANGE_SHA256}  interchange.tar.gz" | sha256sum -c \
    && tar -xz < interchange.tar.gz \
    && mv "interchange-${INTERCHANGE_COMMIT}" interchange \
    && rm interchange.tar.gz

# Copy workspace manifests for dependency install layer caching
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/workbench-shared/package.json packages/workbench-shared/

RUN bun install --frozen-lockfile

# Copy full source
COPY . .

RUN bun run --filter @gtm/api build && bun run --filter @gtm/web build

FROM oven/bun:1.2-slim AS runtime

WORKDIR /app

COPY --from=builder /app/interchange ./interchange
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/apps/api/migrations ./apps/api/migrations

EXPOSE 4000

CMD ["bun", "run", "apps/api/dist/index.js"]
