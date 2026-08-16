# syntax=docker/dockerfile:1

# resvg-js ships prebuilt native binaries per platform and libc, so the build
# and runtime stages must share a base. Both are Debian slim (glibc); an Alpine
# runtime would need a musl build and is deliberately not used.
FROM node:22-slim AS build
WORKDIR /app
# corepack resolves the pnpm version from package.json's `packageManager` field,
# so the image builds with the same pnpm the tests ran under. Without that field
# it silently fetches the newest pnpm ever published, which is how this build
# ended up on pnpm 11 — where an ignored postinstall script is a hard error
# rather than the warning it is on 10.
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

# Install production dependencies fresh rather than copying node_modules from
# the build stage: pnpm's store is a tree of symlinks into `.pnpm`, and copying
# it across stages is fragile. A clean prod install is slower to build and much
# harder to get subtly wrong.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

COPY --from=build /app/dist ./dist
# Resolved at runtime relative to dist/, and the sole reason rendering is
# deterministic — the image is broken without it.
COPY fonts ./fonts

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
