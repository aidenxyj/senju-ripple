# The team server: hub + web app. The desktop app is not part of this image.
# Build from the repo root, since the model client is the shared adapter/:
#   docker build -f app/Dockerfile .
FROM node:22-slim
WORKDIR /srv/senju
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY adapter /srv/adapter
COPY app/src ./src
COPY app/server ./server
COPY app/web ./web
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.js"]
