FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY kb ./kb
RUN mkdir -p /app/data
# 只建立出站连接（QQ 网关 / 飞书 API / 模型 API），不监听任何端口
CMD ["node", "dist/index.js"]
