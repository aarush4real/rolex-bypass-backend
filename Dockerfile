FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY extension ./extension
RUN npm run build

ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
