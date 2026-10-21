FROM oven/bun:1.4.2
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run --cwd apps/web build
ENV WEB_DIST_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "apps/hub/src/index.ts"]
