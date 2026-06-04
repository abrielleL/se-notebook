# ---- build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# install root deps (concurrently etc.)
COPY package*.json ./
RUN npm install

# install and build the client
COPY client/package*.json ./client/
RUN npm install --prefix client

COPY client/ ./client/
RUN npm run build --prefix client

# install server deps
COPY server/package*.json ./server/
RUN npm install --prefix server

# copy server source
COPY server/ ./server/

# ---- runtime stage ----
FROM node:20-slim

WORKDIR /app

# copy server
COPY --from=builder /app/server ./server
COPY --from=builder /app/server/node_modules ./server/node_modules

# copy built frontend
COPY --from=builder /app/client/dist ./client/dist

# scripts folder (import-onenote etc.)
COPY scripts/ ./scripts/

EXPOSE 3001

CMD ["node", "server/index.js"]
