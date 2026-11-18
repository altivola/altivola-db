# syntax=docker/dockerfile:1

# The build output is plain JavaScript, so it is built once on the build
# machine's platform and copied into every target platform's image.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
ARG VERSION=dev
RUN pnpm install --offline --frozen-lockfile \
 && VERSION=$VERSION pnpm --filter @app/server... build \
 && mkdir -p /out/data

# Node on Alpine plus the PostgreSQL client tools, because dump, import and
# copy run pg_dump, pg_restore and psql. Version 18 dumps servers up to 18.
FROM node:24-alpine
RUN apk add --no-cache postgresql18-client tzdata
WORKDIR /app
# One bundle with every dependency inside, and the built web app next to it.
COPY --from=build /repo/apps/api/dist/altivola-db.js /repo/apps/api/dist/altivola-db.js.map ./
COPY --from=build /repo/apps/api/dist/web ./web
RUN chmod +x altivola-db.js && ln -s /app/altivola-db.js /usr/local/bin/altivola-db
COPY --from=build --chown=node:node /out/data /data
USER node

# ALTIVOLA_DB_HOME:            connections and history, mount a volume here
# ALTIVOLA_DB_LISTEN_ANY:      listen on all interfaces inside the container;
#                              publish the port on 127.0.0.1 only
# ALTIVOLA_DB_LOCALHOST_ALIAS: "localhost" in connection URLs means your
#                              machine, not the container
ENV NODE_ENV=production \
    ALTIVOLA_DB_HOME=/data \
    ALTIVOLA_DB_LISTEN_ANY=1 \
    ALTIVOLA_DB_LOCALHOST_ALIAS=host.docker.internal

VOLUME /data
EXPOSE 7789
ENTRYPOINT ["altivola-db"]
CMD ["serve", "--addr", "0.0.0.0:7789", "--no-browser"]
