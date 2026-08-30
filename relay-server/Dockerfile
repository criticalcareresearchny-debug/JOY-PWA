FROM node:22-alpine
WORKDIR /app
COPY relay-server ./relay-server
COPY profile-catalog ./profile-catalog
ENV PORT=8787
EXPOSE 8787
CMD ["node","relay-server/server.js"]
