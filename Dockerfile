FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY client.js session.js sync.js sync-core.js google-calendar.js ./
RUN mkdir /data && chown node:node /data
USER node
ENV SYNC_DB_PATH=/data/sync.sqlite SYNC_SESSION_PATH=/data/schulmanager-session.json
ENTRYPOINT ["node", "sync.js"]
CMD ["--daemon", "--hours", "4"]
