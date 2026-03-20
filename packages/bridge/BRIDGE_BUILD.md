# Bridge Docker Build & Push Script

这个脚本用于构建 bridge 服务的 Docker 镜像并推送到 Azure Container Registry (ACR)。

## 前置要求

1. **Docker** - 已安装并运行
2. **Bun** - 项目包管理器
3. **ACR 访问权限** - 已登录到 Azure Container Registry
4. **Qwen API Key** - 从 [DashScope](https://dashscope.console.aliyun.com/) 获取

## 快速开始

### 1. 配置环境变量

复制 `.env.example` 并填入你的配置：

```bash
cp .env.example .env
# 编辑 .env，填入：
# - ACR_REGISTRY: 你的 ACR 地址（如 myregistry.azurecr.io）
# - DASHSCOPE_API_KEY: 你的 Qwen API key
```

### 2. 登录 ACR

```bash
az acr login --name myregistry
```

### 3. 构建镜像

```bash
# 仅构建，不推送
bun run build:bridge

# 构建并推送到 ACR
bun run build:bridge:push

# 自定义标签
bun scripts/build-bridge-acr.ts --registry myregistry.azurecr.io --tag v1.0.0 --push

# 不使用缓存构建
bun scripts/build-bridge-acr.ts --no-cache --push
```

## 脚本选项

```
--registry <url>        ACR registry URL (必需，或设置 ACR_REGISTRY 环境变量)
--tag <tag>             镜像标签 (默认: latest)
--push                  构建后推送到 ACR
--qwen-key <key>        Qwen API key (默认: 从 DASHSCOPE_API_KEY 环境变量读取)
--no-cache              不使用 Docker 缓存构建
```

## 镜像配置

构建的镜像包含以下配置：

- **基础镜像**: `node:20-slim`
- **全局依赖**: 
  - `opencode-ai`
  - `@qwen-code/qwen-code@latest`
- **暴露端口**: `4096`
- **环境变量**:
  - `BRIDGE_PORT=4096`
  - `ACP_ENGINE=qwen-code`
  - `WORK_DIR=/workspace`
  - `NODE_ENV=production`
  - `DASHSCOPE_API_KEY=<your-key>` (如果提供)

## 运行容器

```bash
# 基础运行
docker run -p 4096:4096 myregistry.azurecr.io/bridge:latest

# 挂载本地工作目录
docker run -p 4096:4096 \
  -v /path/to/your/project:/workspace \
  myregistry.azurecr.io/bridge:latest

# 自定义配置
docker run -p 4096:4096 \
  -e BRIDGE_PORT=4096 \
  -e ACP_ENGINE=qwen-code \
  -e WORK_DIR=/workspace \
  -v /path/to/your/project:/workspace \
  myregistry.azurecr.io/bridge:latest
```

## Qwen 认证配置

镜像会自动配置 Qwen 认证，包括：

1. **环境变量**: `DASHSCOPE_API_KEY` 设置在容器中
2. **settings.json**: 自动生成 `~/.qwen/settings.json`，配置：
   - 模型提供商: OpenAI 兼容接口
   - 认证类型: openai
   - 默认模型: qwen3-coder-plus

如果需要在容器运行时修改认证，可以：

```bash
docker run -p 4096:4096 \
  -e DASHSCOPE_API_KEY=sk-your-new-key \
  myregistry.azurecr.io/bridge:latest
```

## 故障排查

### 镜像构建失败

```bash
# 查看详细日志
docker build -f Dockerfile.bridge -t bridge:latest . --progress=plain

# 不使用缓存重新构建
bun run build:bridge -- --no-cache
```

### 推送失败

```bash
# 确认已登录 ACR
az acr login --name myregistry

# 检查镜像标签
docker images | grep bridge

# 手动推送
docker push myregistry.azurecr.io/bridge:latest
```

### 容器启动失败

```bash
# 查看容器日志
docker logs <container-id>

# 进入容器调试
docker run -it myregistry.azurecr.io/bridge:latest /bin/bash
```

## 健康检查

镜像包含健康检查，会定期检查 `/global/health` 端点：

```bash
# 手动检查
curl http://localhost:4096/global/health
```

## 安全建议

- ⚠️ **不要**将 API key 提交到版本控制
- 使用 `.env` 文件管理敏感信息
- 在生产环境使用 Azure Key Vault 或类似服务管理密钥
- 定期轮换 API key

## 相关文档

- [Bridge 服务文档](./packages/bridge/README.md)
- [Qwen Code 认证配置](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
- [Azure Container Registry](https://learn.microsoft.com/en-us/azure/container-registry/)
