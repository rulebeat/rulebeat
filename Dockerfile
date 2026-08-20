FROM node:22-alpine AS base
WORKDIR /app

# ── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
# Install native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/

RUN npm ci

# ── builder ─────────────────────────────────────────────────────────────────
FROM base AS builder
RUN apk add --no-cache python3 make g++

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build core first, then web
RUN npm run build:core
RUN npm run build --workspace=packages/web

# ── runner ──────────────────────────────────────────────────────────────────
# Next's `output: 'standalone'` (packages/web/next.config.ts) traces the server's actual runtime
# dependency graph and emits a self-contained node_modules — @rulebeat/core included, inlined
# straight into the compiled server chunks since it isn't in serverExternalPackages — so the
# runner no longer needs the full workspace node_modules tree or a compiler toolchain to rebuild
# native bindings; better-sqlite3's prebuilt binary comes along as a real copied package because
# it *is* listed there. No build tools needed at runtime — only the compiled `.node` binary is
# ever loaded, never rebuilt.
FROM base AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/packages/web/.next/standalone ./

# lib/db/migrate.ts does dynamic readdirSync/readFileSync over the data directory (seeding packs,
# legacy-JSON migration); Turbopack's file tracer can't prove those are safe and falls back to
# tracing — and physically copying — this package's entire source tree instead of just what
# server.js actually requires, including whatever happened to be in the *builder's own* data/
# directory (a live SQLite db, if one existed there) and dev-only trees no image should ship.
# None of it is on the runtime require graph (confirmed by inspecting the compiled chunks and
# their .nft.json manifests during the P2-10 build verification) — the compiled server chunks
# already contain everything the app executes. Delete it, then restore only what's genuinely
# needed at runtime: the committed pack seed files, static assets, and public files.
RUN rm -rf packages/web/data packages/web/tests packages/web/scripts packages/web/test-results \
  packages/web/app packages/web/components packages/web/lib packages/web/playwright-report \
  packages/web/playwright.config.ts packages/web/*.tsbuildinfo packages/web/dev-server*.log

COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public
COPY --from=builder /app/packages/web/data/packs ./packages/web/data/packs

# Run as a non-root user. The node images already ship one (uid 1000), so use it rather than
# minting another.
#
# Two directories must be writable by it, not just one: `data` holds the SQLite file and its
# WAL/SHM siblings, and `.next` is written to at runtime (Next.js keeps a runtime cache under
# .next/cache). Everything else — node_modules included — only needs read, which it already has,
# so they are deliberately left alone rather than chowned: `chown -R` on node_modules would
# duplicate the whole layer and bloat the image for no benefit.
#
# Note for bind mounts: Docker preserves this ownership when creating a *named* volume (what
# docker-compose.yml uses), but a bind-mounted host directory keeps the host's ownership — mount
# one and you must chown it to uid 1000 yourself.
RUN chown -R node:node /app/packages/web/data /app/packages/web/.next
USER node

# npm writes its cache to $HOME/.npm; point it somewhere writable so `npx` can't fail on a
# read-only home in hardened runtimes.
ENV NPM_CONFIG_CACHE=/tmp/.npm

VOLUME /app/packages/web/data

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Node's own global `fetch` (stable since Node 18, and this image is node:22) rather than
# installing curl/wget — neither is present in this stage today, and P2-10 already plans to slim
# this image further, so adding a package here just to remove it later would be wasted churn.
# /api/health is unauthenticated by design (see proxy.ts) and does no DB/Azure work, so a
# transient Azure or disk hiccup never restart-loops a container that isn't actually broken.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/web
CMD ["node", "server.js"]
