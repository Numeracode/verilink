FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production=false
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
