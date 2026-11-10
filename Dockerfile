# 博文 Boen —— 生产镜像
#
# 三个阶段：
#   build   —— 装依赖（编译 better-sqlite3）+ 构建前端产物
#   web     —— nginx 静态托管前端（从前一阶段拿 dist，不依赖宿主机构建）
#   runtime —— 服务端运行镜像（默认目标，直接 docker build . 得到的就是它）
#
# 说明：
# - 服务端用 tsx 直跑 TypeScript（与现网 pm2 一致），所以运行阶段保留 devDependencies
# - TiKZ 渲染依赖 xelatex + dvisvgm，默认**不装**（镜像会从 ~200MB 涨到 1GB+）。

# ── 构建阶段 ──────────────────────────────────
FROM node:22-bookworm AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 先只拷贝清单，最大化利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/agent-core/package.json packages/agent-core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build --workspace @boen/web

# ── 前端静态站点 ──────────────────────────────
FROM nginx:1.27-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx-docker.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# ── 服务端运行镜像（默认目标）──────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# 可选：图形渲染
# RUN apt-get update && apt-get install -y --no-install-recommends texlive-xetex texlive-pictures dvisvgm \
#   && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787

COPY --from=build /app /app

# 数据目录（SQLite 库 + 错题图片），compose 里挂卷持久化
RUN mkdir -p /app/apps/server/data/mistake-assets
VOLUME ["/app/apps/server/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/server/src/index.ts"]
