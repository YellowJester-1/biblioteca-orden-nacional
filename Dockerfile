# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# Biblioteca Orden Nacional — imagen del servidor Node
# -----------------------------------------------------------------------------
FROM node:20-alpine

# Pequeña utilidad para healthcheck (opcional)
RUN apk add --no-cache wget

WORKDIR /app

# Instalar dependencias primero (aprovecha la cache de layers).
# Incluimos devDependencies (nodemon) porque el docker-compose corre en modo dev.
COPY package.json ./
RUN npm install

# Copiar el resto del código
COPY server.js ./
COPY public ./public

EXPOSE 3000

# Por defecto arranca en modo producción (node simple).
# El docker-compose sobreescribe el command con "npm run dev" (nodemon).
CMD ["node", "server.js"]
