# --- Build stage ---
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
# Just HEAD/refs/packed-refs (see .dockerignore): the client build stamps the
# commit hash into the UI by reading these files directly.
COPY .git ./.git
RUN pnpm -r run build

# --- Runtime stage ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV CLIENT_DIST=/app/public
ENV DB_PATH=/data/blastmates.db
ENV UPLOADS_DIR=/data/uploads

# Native modules are external to the server bundle; install prebuilt binaries.
RUN npm install --no-save --omit=dev better-sqlite3@^12.10.0 sharp@^0.34.5 \
  && npm cache clean --force

COPY --from=build /app/packages/server/dist/server.cjs ./server.cjs
# Versioned SQL migrations, applied automatically on startup.
COPY --from=build /app/packages/server/drizzle ./drizzle
COPY --from=build /app/packages/client/dist ./public

RUN mkdir -p /data && chown node:node /data
VOLUME /data

EXPOSE 8080
USER node
CMD ["node", "server.cjs"]
