# AI PhotoVault: one image for the web app / API and the background worker (selected by the command).
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY app/shared/package.json app/shared/
COPY app/server/package.json app/server/
COPY app/web/package.json app/web/
RUN npm ci
COPY app app
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PHOTOVAULT_IN_CONTAINER=1 PHOTOVAULT_HOST=0.0.0.0 PHOTOVAULT_API_PORT=8480
WORKDIR /opt/photovault
COPY package.json package-lock.json ./
COPY app/shared/package.json app/shared/
COPY app/server/package.json app/server/
COPY app/web/package.json app/web/
RUN npm ci --omit=dev -w @photovault/server -w @photovault/shared --include-workspace-root=false && npm cache clean --force
COPY --from=build /src/app/shared/dist app/shared/dist
COPY --from=build /src/app/server/dist app/server/dist
COPY app/server/migrations app/server/migrations
COPY --from=build /src/app/web/dist app/web/dist
COPY docker/entrypoint.sh /usr/local/bin/photovault-entrypoint
COPY scripts/validate-install.mjs scripts/validate-install.mjs
RUN chmod +x /usr/local/bin/photovault-entrypoint && mkdir -p /data /state && chown -R node:node /data /state /opt/photovault
USER node
ENV PHOTOVAULT_DATA_ROOT=/data PHOTOVAULT_STATE_DIR=/state PHOTOVAULT_WEB_DIR=/opt/photovault/app/web/dist
EXPOSE 8480
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PHOTOVAULT_API_PORT||8480)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["photovault-entrypoint"]
CMD ["api"]
