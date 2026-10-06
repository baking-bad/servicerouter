# syntax=docker/dockerfile:1
# The website, servicerouter-web on ghcr.io (WB-6): Next.js's standalone server. It reads SITE_URL,
# API_URL, PAY_URL, and WEB_MOCKS at runtime, so one image serves every deployment. Build from the repo
# root: docker build -f packages/web/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build -w @servicerouter/web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# The standalone output traces from the repo root: the server is packages/web/server.js
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
# The commit the image is built from: the startup line names it (L-1). CI passes it.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:3000/_/health || exit 1
CMD ["node", "packages/web/server.js"]
