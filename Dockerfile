FROM docker.io/library/rust:1-bookworm AS wasm-builder
RUN cargo install wasm-pack --locked
WORKDIR /build
COPY wasm-src /build/wasm-src
WORKDIR /build/wasm-src
RUN wasm-pack build --target web --release --out-dir /build/wasm-out

FROM docker.io/library/node:24-bookworm-slim AS app-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && (npm ci --omit=dev || npm install --omit=dev) \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

FROM docker.io/library/node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/uploads /data/thumbs
WORKDIR /app
COPY --from=app-deps /app/node_modules /app/node_modules
COPY package.json /app/
COPY src /app/src
COPY public /app/public
COPY --from=wasm-builder /build/wasm-out /app/public/wasm
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
