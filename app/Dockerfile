FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
RUN npm install -g corepack@latest && corepack enable

# ---- install deps ----
FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY turbo.json ./
# Copy all workspace manifests so Yarn resolves the full dependency graph
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages
RUN yarn install

# ---- build ----
FROM deps AS builder
COPY . .

# NEXT_PUBLIC_* vars baked at build time. Real secrets (NEXTAUTH_SECRET,
# CALENDSO_ENCRYPTION_KEY) are injected at runtime via CF secrets — the
# build-time placeholders here only satisfy next.config.ts existence checks.
ARG NEXT_PUBLIC_WEBAPP_URL=https://book.teddessert.com
# WEBSITE_URL falls back to https://cal.com when unset; the editor and create
# dialog build their preview/copy links from it.
ARG NEXT_PUBLIC_WEBSITE_URL=https://book.teddessert.com
ARG NEXT_PUBLIC_CONVEX_URL=https://effervescent-dinosaur-191.convex.cloud
ARG NEXT_PUBLIC_CONVEX_SITE_URL=https://effervescent-dinosaur-191.convex.site
ARG NEXTAUTH_SECRET=placeholder-build-only-replaced-at-runtime
ARG CALENDSO_ENCRYPTION_KEY=placeholder-build-only
# Brand the app (drives APP_NAME app-wide: landing heading, onboarding header, …).
# NEXT_PUBLIC_* are inlined at `next build`, so this must be set in the builder.
ARG NEXT_PUBLIC_APP_NAME="Ted Dessert"

ENV NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL \
    NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL \
    NEXT_PUBLIC_WEBSITE_URL=$NEXT_PUBLIC_WEBSITE_URL \
    NEXT_PUBLIC_CONVEX_SITE_URL=$NEXT_PUBLIC_CONVEX_SITE_URL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXTAUTH_SECRET=$NEXTAUTH_SECRET \
    CALENDSO_ENCRYPTION_KEY=$CALENDSO_ENCRYPTION_KEY \
    BUILD_STANDALONE=true \
    NEXT_TELEMETRY_DISABLED=1 \
    SKIP_DB_MIGRATIONS=1 \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=6144

# Run next build directly — skips the sentry:release step in the npm script.
# copy-app-store-static first: turbo's `build` task depends on it, a raw
# `next build` does not, and the OG-image route imports the JSON it writes.
WORKDIR /app/apps/web
RUN yarn copy-app-store-static && yarn next build

# ---- runtime ----
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Standalone output includes the server + all traced node_modules.
# outputFileTracingRoot (workspace root) ensures packages/* are included.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
