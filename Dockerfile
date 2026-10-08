FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

# Install devDependencies because the TypeScript compiler is needed during the image build.
# Set production mode only after compilation is complete.
COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY extension ./extension
RUN npm run build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
