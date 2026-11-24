# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production \
    HGA_DB_PATH=/data/hga.db
WORKDIR /app
# No runtime dependencies; package.json is kept for "type": "module".
COPY package.json ./
COPY --from=build /app/dist/src ./dist/src
COPY migrations ./migrations
# The named volume mounts here; pre-create it so the volume is owned by the node user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "dist/src/bin.js"]
CMD ["--help"]
