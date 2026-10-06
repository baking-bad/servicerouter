# syntax=docker/dockerfile:1
# One image for every app. Each stack service sets its command: node packages/<app>/dist/main.js.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build
RUN rm -rf packages/*/src packages/*/tests packages/*/tsconfig*.json packages/*/dist/.tsbuildinfo

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
USER node
CMD ["node", "packages/proxy/dist/main.js"]
