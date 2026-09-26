FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux procps git ca-certificates fd-find ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-pi-declarations.mjs scripts/patch-pi-declarations.mjs
RUN npm ci
COPY . .
ENV PATH="/app/node_modules/.bin:${PATH}"
CMD ["sh", "-c", "npm test && npm run test:e2e"]
