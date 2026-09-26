# NOTE: render.yaml sets `runtime: node`, so Render builds this service with
# its own native Node buildpack and does NOT use this Dockerfile at all.
# It's kept here for local Docker use / other hosts. If you want Render to
# actually build from this file, change render.yaml to `runtime: docker`
# (and set dockerCommand/startCommand accordingly) instead of relying on
# this FROM line to pin the Node version on Render.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/downloads

ENV NODE_ENV=production

CMD ["node", "src/main.js"]
