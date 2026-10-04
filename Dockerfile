FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json index.ts ./
COPY src ./src
RUN npm run build

# Internal-only service: reached by the portal over the private network with
# the shared MCP_SERVICE_TOKEN; never exposed through the public load balancer.
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/index.js ./index.js
COPY --from=build /app/src/*.js ./src/
USER node
EXPOSE 3002
CMD ["node", "index.js"]
