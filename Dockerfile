FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000
ENV DATABASE_PATH=/app/data/chat.db

WORKDIR /app

COPY package.json server.js ./
COPY static ./static

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then((r)=>r.json()).then((h)=>process.exit(h.status==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
