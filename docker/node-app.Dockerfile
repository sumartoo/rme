# syntax=docker/dockerfile:1.7
# Image API / worker NestJS (multi-stage). Pemakaian (dari root repo):
#   docker build -f docker/node-app.Dockerfile --build-arg APP=api    -t clinicrme-api .
#   docker build -f docker/node-app.Dockerfile --build-arg APP=worker -t clinicrme-worker .
# Hasil: distroless (tanpa shell & package manager), user non-root, hanya dependency produksi aplikasi itu.
# Image api juga berisi migrasi: jalankan sebagai job terpisah dengan role owner →  CMD ["migrate.js"]
#   (MIGRATION_DATABASE_URL, MIGRATIONS_DIR=/app/db/migrations).
# Mayor Node terkunci (.nvmrc); tag minor/digest diperbarui Dependabot
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG APP
ENV CI=true NX_DAEMON=false NX_NO_CLOUD=true
WORKDIR /repo
RUN corepack enable
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm nx run @clinicrme/${APP}:build --skip-nx-cache
# Dependency produksi aplikasi saja (pnpm deploy), lalu bundle webpack di atasnya
RUN pnpm --filter @clinicrme/${APP} deploy --prod --legacy /out \
 && cp apps/${APP}/dist/*.js /out/ \
 && mkdir -p /out/db && if [ "${APP}" = "api" ]; then cp -r db/migrations /out/db/migrations && cp -r db/reference /out/db/reference; fi \
 # Seed data demo SINTETIS untuk VPS dev (CR-0003): satu berkas, memakai pg & argon2 dari dependency api; ditolak di staging/prod
 && if [ "${APP}" = "api" ]; then pnpm exec esbuild tools/dev/seed.ts --bundle --platform=node --target=node22 \
      --external:pg --external:@node-rs/argon2 --outfile=/out/seed.js --log-level=warning; fi

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /out/*.js ./
COPY --from=build --chown=nonroot:nonroot /out/db ./db
USER nonroot
EXPOSE 3000
CMD ["main.js"]
