# syntax=docker/dockerfile:1
# One image for every app. Each stack service sets its command: node packages/<app>/dist/main.js.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build
RUN rm -rf packages/*/src packages/*/tests packages/*/tsconfig*.json packages/*/drizzle.config.ts packages/*/dist/.tsbuildinfo

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# Migrations run as a one-off command before the apps roll (S1-D3): node packages/db/dist/migrate.js,
# which applies packages/db/migrations/ to DATABASE_URL.
# Platform configs, one per deployment (PC-1). The stack picks one with CONFIG_PATH.
COPY config ./config
USER node
CMD ["node", "packages/proxy/dist/main.js"]
