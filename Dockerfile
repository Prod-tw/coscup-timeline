FROM node:24-bookworm-slim AS dashboard
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/editor/package.json apps/editor/package.json
RUN pnpm install --frozen-lockfile
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @coscup/dashboard build

FROM rust:1.96-bookworm AS server-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
COPY apps/editor/src-tauri/Cargo.toml apps/editor/src-tauri/Cargo.toml
COPY apps/editor/src-tauri/build.rs apps/editor/src-tauri/build.rs
COPY apps/editor/src-tauri/src apps/editor/src-tauri/src
COPY apps/editor/src-tauri/tauri.conf.json apps/editor/src-tauri/tauri.conf.json
COPY apps/editor/src-tauri/capabilities apps/editor/src-tauri/capabilities
RUN mkdir -p apps/editor/src-tauri/binaries && touch apps/editor/src-tauri/binaries/coscup-ffmpeg-x86_64-unknown-linux-gnu apps/editor/src-tauri/binaries/coscup-ffprobe-x86_64-unknown-linux-gnu
RUN cargo build --release -p coscup-time-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-build /src/target/release/coscup-time-server /usr/local/bin/coscup-time-server
COPY --from=dashboard /src/apps/dashboard/dist /app/dashboard
RUN mkdir -p /data
ENV DATABASE_URL=sqlite:///data/coscup-time.db \
    DASHBOARD_DIR=/app/dashboard \
    BIND_ADDRESS=0.0.0.0:3000
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD curl --fail http://127.0.0.1:3000/api/v1/health || exit 1
CMD ["coscup-time-server"]
