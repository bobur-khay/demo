# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app
COPY client/package.json client/package-lock.json ./
COPY client/vendor ./vendor
RUN npm ci
COPY client/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80