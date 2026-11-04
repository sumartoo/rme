# syntax=docker/dockerfile:1.7
# Image Next.js (output standalone) untuk apps/web atau apps/platform-admin.
# Pemakaian: docker build -f docker/web.Dockerfile [--build-arg APP=platform-admin] -t clinicrme-web .
# Mayor Node terkunci (.nvmrc); tag minor/digest diperbarui Dependabot
ARG NODE_VERSION=22
ARG APP=web

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG APP
ENV CI=true NX_DAEMON=false NX_NO_CLOUD=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
RUN corepack enable
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm nx run @clinicrme/${APP}:build --skip-nx-cache

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG APP
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=build --chown=nonroot:nonroot /repo/apps/${APP}/public ./apps/${APP}/public
USER nonroot
EXPOSE 3000
# CMD bentuk exec tidak mengekspansi ARG; WORKDIR mengekspansinya
WORKDIR /app/apps/${APP}
CMD ["server.js"]
