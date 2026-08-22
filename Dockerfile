FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json server.js ./
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
USER node

CMD ["node", "server.js"]
