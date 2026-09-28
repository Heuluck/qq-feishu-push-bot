FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /app
ENV NODE_ENV=production
# 不装 git：正式知识库的提交由宿主脚本完成（见 scripts/kb-commit.sh），容器只写提交请求，
# 不挂 .git、也不需要 git 二进制。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY kb ./kb
RUN mkdir -p /app/data && chown node:node /app/data
# 用非 root 跑：这个进程会解析用户上传的图片（libvips 是原生代码），一旦被攻破，
# 非 root 能把它限制在容器内。uid 由 compose 的 user: 覆盖，见 docker-compose.yml。
USER node
# 只建立出站连接（QQ 网关 / 飞书 API / 模型 API），不监听任何端口
CMD ["node", "dist/index.js"]
