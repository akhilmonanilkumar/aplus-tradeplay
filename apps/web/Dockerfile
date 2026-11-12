# Dashboard (Next.js standalone). Build from the repository root:
#   docker build -f apps/web/Dockerfile --secret id=webenv,src=services/engine/deploy/web.env .
# The env file is mounted only while building (NEXT_PUBLIC_* values are inlined into the browser bundle);
# no secret is kept in an image layer. At run time the same file is passed as the container's environment.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY services/engine/package.json services/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter web...
COPY packages/engine packages/engine
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=2048
RUN --mount=type=secret,id=webenv,target=/repo/apps/web/.env.production \
    pnpm --filter web build \
 && rm -f apps/web/.next/standalone/apps/web/.env*

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://localhost:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
