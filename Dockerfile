# TryBack production image: the Next.js standalone server for ONE machine with a persistent
# volume at /data (JSON store, shopper photos, render cache). See docs/DEPLOY.md.
#
#   docker build -t tryback .
#   docker run -p 3000:3000 -v tryback_data:/data --env-file .env.production --stop-timeout 120 tryback
#
# Behind a TLS-inspecting proxy (npm or Google Fonts fail with UNABLE_TO_GET_ISSUER_CERT_LOCALLY),
# pass a CA bundle that has the public roots AND your company root as a build secret. It is only
# mounted for the RUN steps that need it and is never written into a layer:
#   docker build --secret id=ca,src=/path/to/ca-bundle.pem -t tryback .
#
# No secrets are baked in: .env* files are excluded by .dockerignore, and CLOTHSY_API_KEY,
# LIVE_ACCESS_CODE, ADMIN_TOKEN and ANTHROPIC_API_KEY are runtime env vars only.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. Dependencies (Linux: sharp, SWC, lightningcss and Tailwind get their linux binaries) ──
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export npm_config_cafile=/run/secrets/ca NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund --loglevel=error

# ── 2. Build ──
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next/font downloads the Geist fonts at build time (the CA secret covers proxies here too).
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npx next build
# Assemble the runtime tree: standalone server + traced node_modules, static chunks, public/
# (MediaPipe WASM + models, catalogue images; the server reads garment shots from public/).
# (Copy directory CONTENTS: Turbopack may already have traced part of public/ into standalone.)
RUN mkdir -p /out/.next/static /out/public \
 && cp -R .next/standalone/. /out/ \
 && cp -R .next/static/. /out/.next/static/ \
 && cp -R public/. /out/public/ \
 && mkdir -p /out/seed && cp -R seed/. /out/seed/ \
 && cp scripts/docker-entrypoint.sh /out/docker-entrypoint.sh \
 && chmod 755 /out/docker-entrypoint.sh \
 && rm -f /out/.env /out/.env.production \
 && test -f /out/server.js \
 && test -d /out/node_modules/sharp \
 && test ! -e /out/public/public \
 && test -f /out/public/mediapipe/vision_wasm_internal.wasm \
 && test -f /out/seed/render-cache/index.json

# ── 3. Runtime ──
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TRYBACK_DATA_DIR=/data \
    NEXT_TELEMETRY_DISABLED=1
# The app files belong to root (read-only for the server); only /data is writable by `node`.
COPY --from=build /out ./
RUN mkdir -p /data /app/.next/cache \
 && chown node:node /data /app/.next/cache \
 && command -v setpriv >/dev/null
VOLUME /data
EXPOSE 3000
# The entrypoint chowns the mounted volume and drops to the unprivileged `node` user.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Renders finish in after() callbacks; give them time on shutdown (see --stop-timeout / kill_timeout).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
