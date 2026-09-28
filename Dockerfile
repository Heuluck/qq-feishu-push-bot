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
# git 只给「正式知识库（kb.yaml）卡片改动后自动提交」用：容器里跑 git commit，
# work-tree 就是 /app，宿主仓库的 .git 由 compose 挂到 /app/.git（见 docker-compose.yml）。
# --no-install-recommends 避免拖进一堆用不上的东西；装完立刻清 apt 缓存。
# 构建在本机（国内网络）进行，deb.debian.org 的 security 源偶发 502，所以换国内镜像。
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      [ -f "$f" ] && sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' "$f" || true; \
    done; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    rm -rf /var/lib/apt/lists/*
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
