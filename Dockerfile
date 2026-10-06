FROM node:20-alpine AS build
WORKDIR /app
# Slow or flaky links: retry downloads patiently, and share one npm cache across
# stages and builds (BuildKit cache mount) so packages download only once.
ENV npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=180000 \
    npm_config_fetch_timeout=600000
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline
COPY tsconfig.json index.ts ./
COPY src ./src
RUN npm run build

# Internal-only service: reached by the portal over the private network with
# the shared MCP_SERVICE_TOKEN; never exposed through the public load balancer.
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=180000 \
    npm_config_fetch_timeout=600000
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefer-offline
COPY --from=build /app/index.js ./index.js
COPY --from=build /app/src/*.js ./src/
USER node
EXPOSE 3002
CMD ["node", "index.js"]
