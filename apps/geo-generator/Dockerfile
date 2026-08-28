FROM 883424753239.dkr.ecr.ap-northeast-2.amazonaws.com/apne2-devops-base-nodejs:24.14.0-alpine3.22 AS build

RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentic-geo/geo-generator build

FROM node:24-alpine AS run

WORKDIR /repo
COPY --from=build /repo /repo

WORKDIR /repo/apps/geo-generator

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

USER node

CMD ["./node_modules/.bin/next", "start"]
