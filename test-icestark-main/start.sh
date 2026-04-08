#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE} Icestark 主应用 + OpenCode 微应用启动脚本${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 清理端口的函数
kill_port() {
  local port=$1
  local pids=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pids" ]; then
    echo -e "${YELLOW}清理端口 $port (PIDs: $pids)${NC}"
    echo "$pids" | xargs kill -9 2>/dev/null
  fi
}

# 清理已有进程和端口
echo -e "${YELLOW}正在清理已有进程和端口...${NC}"
kill_port 3000
kill_port 4001
kill_port 4096
kill_port 5001
sleep 1

# 确认端口已释放
check_port_free() {
  local port=$1
  if lsof -ti :$port > /dev/null 2>&1; then
    return 1  # 端口被占用
  else
    return 0  # 端口空闲
  fi
}

if ! check_port_free 3000; then
  echo -e "${RED}✗ 端口 3000 无法释放，请手动检查${NC}"
  lsof -i :3000
  exit 1
fi

if ! check_port_free 4001; then
  echo -e "${RED}✗ 端口 4001 无法释放，请手动检查${NC}"
  lsof -i :4001
  exit 1
fi

if ! check_port_free 4096; then
  echo -e "${RED}✗ 端口 4096 无法释放，请手动检查${NC}"
  lsof -i :4096
  exit 1
fi

if ! check_port_free 5001; then
  echo -e "${RED}✗ 端口 5001 无法释放，请手动检查${NC}"
  lsof -i :5001
  exit 1
fi

echo -e "${GREEN}✓ 端口已清理${NC}"
echo ""

# 构建微应用 (微应用模式)
echo -e "${GREEN}构建微应用 (OpenCode) - UMD 模块格式${NC}"
cd /Users/terry/work/opencode/packages/app
BUILD_MODE=micro-app VITE_OPENCODE_SERVER_HOST=localhost VITE_OPENCODE_SERVER_PORT=4096 bunx vite build
if [ $? -ne 0 ]; then
  echo -e "${RED}✗ 微应用构建失败${NC}"
  exit 1
fi
echo -e "${GREEN}✓ 微应用构建完成${NC}"
echo ""

# 启动 wss-server (ACP WebSocket 代理)
echo -e "${GREEN}启动 wss-server (Qwen-ACP) on http://localhost:5001${NC}"
cd /Users/terry/work/opencode/packages/opencode-qwen-acp-demo
nohup env PORT=5001 bun run src/wss-server.ts > /tmp/wss-server.log 2>&1 &
WSS_PID=$!
disown $WSS_PID
echo "wss-server PID: $WSS_PID"
sleep 2

if curl -s http://localhost:5001/ > /dev/null 2>&1; then
  echo -e "${GREEN}✓ wss-server 启动成功${NC}"
else
  echo -e "${YELLOW}⚠ wss-server 可能还在启动中，请检查日志: /tmp/wss-server.log${NC}"
fi
echo ""

# 启动 bridge (连接 wss-server)
echo -e "${GREEN}启动 bridge on http://localhost:4096${NC}"
cd /Users/terry/work/opencode/packages/bridge
nohup env BRIDGE_PORT=4096 WSS_SERVER_URL=ws://localhost:5001/ws bun run src/index.ts > /tmp/bridge.log 2>&1 &
BRIDGE_PID=$!
disown $BRIDGE_PID
echo "bridge PID: $BRIDGE_PID"
sleep 2

if curl -s http://localhost:4096/global/health > /dev/null 2>&1; then
  echo -e "${GREEN}✓ bridge 启动成功${NC}"
else
  echo -e "${YELLOW}⚠ bridge 可能还在启动中，请检查日志: /tmp/bridge.log${NC}"
fi
echo ""

# 启动微应用静态服务器
echo -e "${GREEN}启动微应用静态服务器 on http://localhost:3000${NC}"
cd /Users/terry/work/opencode/packages/app/dist
nohup bunx serve -l 3000 --cors > /tmp/micro-app.log 2>&1 &
MICRO_PID=$!
disown $MICRO_PID
echo "微应用 PID: $MICRO_PID"

# 等待微应用启动
sleep 3

# 检查微应用是否成功启动
if curl -s http://localhost:3000/ > /dev/null 2>&1; then
  echo -e "${GREEN}✓ 微应用启动成功${NC}"
else
  echo -e "${YELLOW}⚠ 微应用可能还在启动中，请检查日志: /tmp/micro-app.log${NC}"
fi

echo ""

# 启动主应用
echo -e "${GREEN}启动主应用 (Icestark) on http://localhost:4001${NC}"
cd /Users/terry/work/opencode/test-icestark-main
nohup bunx vite --port 4001 --host > /tmp/main-app.log 2>&1 &
MAIN_PID=$!
disown $MAIN_PID
echo "主应用 PID: $MAIN_PID"

# 等待主应用启动
sleep 3

# 检查主应用是否成功启动
if curl -s http://localhost:4001/ > /dev/null 2>&1; then
  echo -e "${GREEN}✓ 主应用启动成功${NC}"
else
  echo -e "${YELLOW}⚠ 主应用可能还在启动中，请检查日志: /tmp/main-app.log${NC}"
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}服务启动完成!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "主应用 (Icestark): ${GREEN}http://localhost:4001/${NC}"
echo -e "微应用 (OpenCode): ${GREEN}http://localhost:3000/${NC}"
echo -e "Bridge API:       ${GREEN}http://localhost:4096/${NC}"
echo -e "WSS Server:       ${GREEN}http://localhost:5001/${NC}"
echo ""
echo -e "日志文件:"
echo -e "  主应用:    /tmp/main-app.log"
echo -e "  微应用:    /tmp/micro-app.log"
echo -e "  Bridge:    /tmp/bridge.log"
echo -e "  WSS:       /tmp/wss-server.log"
echo ""
echo -e "停止服务: ${YELLOW}./stop.sh${NC}"
echo ""

# 保存 PID 到文件
echo "$MICRO_PID" > /tmp/micro-app.pid
echo "$MAIN_PID" > /tmp/main-app.pid
echo "$BRIDGE_PID" > /tmp/bridge.pid
echo "$WSS_PID" > /tmp/wss-server.pid