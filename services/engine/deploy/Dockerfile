# Build from the repository root: docker build -f services/engine/deploy/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY services/engine/package.json services/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @aplus/engine-host...
COPY packages/engine packages/engine
COPY services/engine services/engine
RUN pnpm --filter @aplus/engine-host build && pnpm deploy --filter @aplus/engine-host --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
