FROM node:18-alpine

# Installer les dépendances pour la compilation des modules natifs
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
