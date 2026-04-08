# OpenCode 微应用部署指南

## 问题说明

当前 Docker 构建失败的原因是 **Docker 代理配置问题**：
- 错误信息：`http: server gave HTTP response to HTTPS client`
- 原因：Docker Desktop 配置的代理 `http.docker.internal:3128` 无法正常工作

## 解决方案

### 方案 1: 修复 Docker 代理（推荐用于生产环境）

1. **打开 Docker Desktop**
2. **进入 Settings → Resources → Proxies**
3. **取消勾选 "Use system proxy"**
4. **手动配置代理**（如果你有可用的代理）或者**留空使用直连**
5. **点击 "Apply & Restart"**

或者编辑 Docker Engine 配置（Settings → Docker Engine）：
```json
{
  "proxies": {}
}
```

### 方案 2: 使用国内镜像加速器

在 Docker Engine 配置中添加：
```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://huecker.io",
    "https://dockerhub.timeweb.cloud"
  ]
}
```

### 方案 3: 本地启动（推荐用于开发测试）✅

**已创建本地启动脚本**：`start-local.bat`

使用方法：
```bash
# 在项目根目录执行
.\start-local.bat
```

该脚本会：
1. 清理端口（3000, 4001, 4096, 5001）
2. 构建微应用（packages/app）
3. 启动 wss-server（端口 5001）
4. 启动 bridge（端口 4096）
5. 启动静态文件服务器（端口 3000）
6. 启动主应用（端口 4001）

停止服务：关闭所有打开的命令行窗口，或按 Ctrl+C

## 架构说明

```
┌─────────────────────────────────────────┐
│         主应用 (Icestark)                │
│         http://localhost:4001            │
└──────────────┬──────────────────────────┘
               │ 加载微应用
               ▼
┌─────────────────────────────────────────┐
│      微应用静态服务器                     │
│      http://localhost:3000               │
│      (packages/app/dist)                 │
└──────────────┬──────────────────────────┘
               │ API 请求
               ▼
┌─────────────────────────────────────────┐
│         Bridge                           │
│         http://localhost:4096            │
│         (packages/bridge)                │
└──────────────┬──────────────────────────┘
               │ WebSocket
               ▼
┌─────────────────────────────────────────┐
│      WSS Server (ACP Proxy)              │
│      ws://localhost:5001/ws              │
│      (packages/opencode-qwen-acp-demo)   │
└──────────────┬──────────────────────────┘
               │ stdio
               ▼
┌─────────────────────────────────────────┐
│      Qwen CLI (qwen-code)                │
│      需要全局安装: npm i -g @qwen-code..│
└─────────────────────────────────────────┘
```

## 前置要求

1. **安装 Bun**
   ```bash
   # Windows (PowerShell)
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **安装 qwen-code CLI**
   ```bash
   npm install -g @qwen-code/qwen-code
   ```

3. **验证安装**
   ```bash
   bun --version
   qwen --version
   ```

## Docker 构建（网络问题解决后）

当 Docker 网络问题解决后，执行：

```bash
# 构建镜像
docker build -f Dockerfile.micro-app -t opencode-micro-app:latest .

# 运行容器
docker run -d `
  --name opencode-container `
  -p 3000:3000 `
  -p 4096:4096 `
  -p 5001:5001 `
  opencode-micro-app:latest

# 查看日志
docker logs -f opencode-container

# 停止容器
docker stop opencode-container
docker rm opencode-container
```

## 验证服务

启动后访问以下地址验证：

- **主应用**: http://localhost:4001/opencode
- **微应用**: http://localhost:3000/
- **Bridge Health**: http://localhost:4096/global/health
- **WSS Health**: http://localhost:5001/health

## 常见问题

### 1. qwen CLI 未找到

```bash
npm install -g @qwen-code/qwen-code
```

或在 Dockerfile 中已包含自动安装。

### 2. 端口被占用

```bash
# Windows
netstat -ano | findstr :3000
taskkill /F /PID <PID>

# 或使用 start-local.bat 自动清理
```

### 3. 依赖安装失败

```bash
# 清除缓存重新安装
bun install --force
```

### 4. Docker 拉取镜像超时

参考上面的"方案 1"和"方案 2"配置代理或镜像加速器。

## 优化说明

### Dockerfile 优化点

1. **使用 bun 作为包管理器** - 比 npm/yarn 快 10-100 倍
2. **分层复制** - 先复制 package.json，利用 Docker 缓存
3. **只复制必要目录** - 避免复制整个项目
4. **多阶段构建** - 减小最终镜像体积
5. **安装 qwen-code CLI** - 在运行时镜像中全局安装

### 构建速度对比

- **优化前**: 每次全量复制，重新安装所有依赖 (~5-10 分钟)
- **优化后**: 利用缓存，只重建变化的部分 (~1-2 分钟)

## 下一步

1. 解决 Docker 网络问题
2. 成功构建并测试 Docker 镜像
3. 验证容器内服务正常运行
4. 本地主应用连接容器中的微应用
