FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentic-geo/agent-api build

FROM node:24-alpine AS run
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/agent-api
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
