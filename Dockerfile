FROM oven/bun:1 AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/
COPY packages/web/package.json packages/web/tsconfig.json ./packages/web/
RUN bun install --frozen-lockfile

COPY packages ./packages
RUN bun run build

FROM oven/bun:1

WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock /app/tsconfig.json ./
COPY --from=build /app/packages/shared/package.json /app/packages/shared/tsconfig.json ./packages/shared/
COPY --from=build /app/packages/server/package.json /app/packages/server/tsconfig.json ./packages/server/
COPY --from=build /app/packages/web/package.json /app/packages/web/tsconfig.json ./packages/web/
RUN bun install --frozen-lockfile --production
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/packages/server/src ./packages/server/src
COPY --from=build /app/packages/web/dist ./packages/web/dist

ENV OLIVE_CONFIG_DIR=/data/config
ENV OLIVE_MEETINGS_DIR=/data/meetings
ENV OLIVE_BIND_HOST=0.0.0.0
ENV OLIVE_BIND_PORT=4471
VOLUME ["/data"]
EXPOSE 4471

CMD ["bun", "run", "packages/server/src/index.ts"]
