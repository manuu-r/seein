FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN npx playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY --from=build /app/renderer/atlas ./renderer/atlas
EXPOSE 8787
CMD ["node", "dist/server/server.js"]
