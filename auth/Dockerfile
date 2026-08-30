FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/__auth/health || exit 1
ENTRYPOINT ["node", "server.js"]
