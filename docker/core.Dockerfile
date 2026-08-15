FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.8.11 AS uv

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV UV_TOOL_BIN_DIR=/usr/local/bin
ARG QWEN_MM_REF=qwen-mm-plugins-blender-v1.0.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends blender git xvfb ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
RUN uv tool install "qwen-mm-plugins[blender] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@${QWEN_MM_REF}"
COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium
RUN apt-get update \
    && apt-get install -y --no-install-recommends xauth \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-numpy python3-requests \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/server/server.js"]
