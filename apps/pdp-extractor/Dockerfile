FROM node:24.14.0-alpine3.22 AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentic-geo/pdp-extractor build

FROM node:24-alpine AS run
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/pdp-extractor
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# Set at deployment time to the separately deployed Python Agent API.
ENV AGENTIC_GEO_API_URL=
EXPOSE 3000
USER node
CMD ["./node_modules/.bin/next","start"]
