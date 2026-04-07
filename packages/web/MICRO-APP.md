# OpenCode Web 微应用接入指南

本文档说明如何将 packages/web 作为 icestark 微应用接入主应用。

## 技术方案

由于 packages/web 是基于 Astro + Starlight 的文档站点，采用 **HTML Entry** 方式接入 icestark。

### 为什么选择 HTML Entry？

1. Astro 是静态站点生成器，天然适合输出 HTML
2. Starlight 主题包含大量客户端交互逻辑，需要完整的 HTML 环境
3. HTML Entry 方式与 icestark 的 `entry` 配置兼容

## 微应用改造说明

### 已完成的改造

1. **安装依赖**: `@ice/stark-app` - icestark 微应用 SDK
2. **入口文件**: `src/micro-app.ts` - 导出 mount/unmount 生命周期
3. **渲染模块**: `src/app.ts` - 处理微应用的挂载和卸载逻辑
4. **样式隔离**: `src/styles/micro-app.css` - 命名空间样式防止污染
5. **路由适配**: `src/utils/router.ts` - 支持 getBasename() 动态路由
6. **构建配置**: 支持 `BUILD_MODE=micro-app` 静态构建模式

### 构建输出

```bash
bun run build:micro-app
```

输出目录：`dist/`
- 静态资源（JS/CSS/图片）
- HTML 入口文件（需要额外配置）

## 主应用接入示例

### 1. 使用 entry 方式（推荐）

```javascript
import { registerMicroApps, start } from '@ice/stark';

registerMicroApps([
  {
    name: 'opencode-web',
    activePath: '/docs',
    title: 'OpenCode 文档',
    container: document.getElementById('micro-app-container'),
    entry: 'https://your-cdn.com/opencode-web/index.html',
    props: {
      // 传递给微应用的自定义属性
      theme: 'light'
    }
  }
]);

start();
```

### 2. 使用 url 方式

如果已经将构建产物部署到 CDN：

```javascript
registerMicroApps([
  {
    name: 'opencode-web',
    activePath: '/docs',
    title: 'OpenCode 文档',
    container: document.getElementById('micro-app-container'),
    url: [
      'https://your-cdn.com/opencode-web/assets/index.js',
      'https://your-cdn.com/opencode-web/assets/index.css'
    ]
  }
]);
```

## 注意事项

### 1. 路由处理

微应用内部使用 `getBasename()` 获取基准路由：

```typescript
import { getBasename } from '@ice/stark-app';

// 在微应用中使用
const basePath = getBasename(); // 返回 '/docs' 或其他配置的路径
```

### 2. 样式隔离

- 微应用自动添加 `.opencode-web-micro-app` 类名到容器
- 样式文件使用命名空间选择器避免全局污染
- 建议主应用也使用 CSS Modules 或命名空间

### 3. 构建配置

微应用构建时使用静态输出模式：

```javascript
// astro.config.mjs
const isMicroApp = process.env.BUILD_MODE === 'micro-app'

export default defineConfig({
  output: isMicroApp ? "static" : "server",
  base: isMicroApp ? "/" : "/docs",
  // ...
})
```

### 4. 生命周期

- `mount`: 创建容器、初始化应用、添加样式类名
- `unmount`: 清理 DOM、移除样式、断开观察者

## 开发调试

### 本地开发

```bash
# 正常开发模式
bun run dev

# 构建微应用
bun run build:micro-app
```

### 测试微应用

1. 构建微应用：`bun run build:micro-app`
2. 部署 `dist/` 目录到静态服务器
3. 在主应用中配置 entry 指向部署地址
4. 访问主应用的 `/docs` 路径测试

## 常见问题

### Q: 微应用加载后样式错乱？

A: 检查：
1. 主应用和微应用的样式是否冲突
2. 是否正确添加了 `.opencode-web-micro-app` 命名空间
3. 全局样式（如 normalize.css）是否重复引入

### Q: 路由跳转不生效？

A: 检查：
1. 微应用是否正确使用 `getBasename()`
2. 主应用的 `activePath` 配置是否正确
3. 路由模式（hash/browser）是否一致

### Q: 构建失败？

A: 检查：
1. 环境变量 `BUILD_MODE=micro-app` 是否正确设置
2. 依赖 `@ice/stark-app` 是否已安装
3. TypeScript 类型是否正确

## 相关文件

- `src/micro-app.ts` - 微应用入口
- `src/app.ts` - 渲染逻辑
- `src/styles/micro-app.css` - 样式隔离
- `src/utils/router.ts` - 路由工具
- `astro.config.mjs` - 构建配置
