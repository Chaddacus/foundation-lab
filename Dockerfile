# Foundation Lab runtime image.
#
# Build once, promote the same artifact. The image DIGEST is the release identity, and it is
# what Gate #2 authorizes — not a tag, which can be moved to point at different bytes.
#
# The build stamps source revision and version. It cannot stamp its own digest, which is only
# known after the layers exist, so the digest is supplied at deploy time and reported by
# /api/meta. A container therefore always states which artifact it actually is.

# Base pinned by DIGEST, not by tag. `node:26-alpine` moves, so rebuilding the same source
# against a tag can produce different bytes — which would make "the same artifact" a claim
# nobody could check. This is the one line that makes build-once meaningful.
FROM node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS deps

WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# Production dependencies only. Playwright and TypeScript are verification tooling and have
# no business in a runtime image — they would enlarge the attack surface for no benefit.
# pnpm pinned to the version that produced the lockfile. The base image ships npm only.
# `--frozen-lockfile` makes the build fail rather than silently resolve different versions.
RUN npm install -g pnpm@10.29.2 \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS runtime

# Release identity, stamped at build time.
ARG FL_VCS_REF=unknown
ARG FL_SERVICE_VERSION=0.0.0

LABEL org.opencontainers.image.title="foundation-lab" \
      org.opencontainers.image.revision="${FL_VCS_REF}" \
      org.opencontainers.image.version="${FL_SERVICE_VERSION}"

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

ENV FL_VCS_REF=${FL_VCS_REF} \
    FL_SERVICE_VERSION=${FL_SERVICE_VERSION} \
    NODE_ENV=production

# Runs as the image's non-root user. A process that never needs to write outside its data
# volume should not be able to.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4310

# No HEALTHCHECK here on purpose: a health check is a liveness signal and is NOT verification
# (Standard 4). The FAST tier is what says the deployment is good; conflating the two would
# let a container that merely responds look like a validated release.

CMD ["node", "src/spine/main.ts"]
