FROM node:20-slim

WORKDIR /app

# 复制 bridge 包
COPY packages/bridge .

# 安装依赖
RUN npm install

# 创建工作目录
RUN mkdir -p /workspace

# 暴露端口
EXPOSE 4096

# 环境变量配置
ENV BRIDGE_PORT=4096
ENV ACP_ENGINE=qwen-code
ENV WORK_DIR=/workspace
ENV NODE_ENV=production

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4096/global/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
