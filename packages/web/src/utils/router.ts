import { getBasename, isInIcestark } from '@ice/stark-app';

/**
 * 获取基础路径
 * 在 icestark 微应用环境中返回动态获取的 basename
 * 独立运行时返回配置的 base
 */
export function getBasePath(): string {
  if (isInIcestark()) {
    // 在 icestark 环境中使用动态获取的 basename
    const basename = getBasename();
    return basename || '/';
  }
  // 独立运行时使用配置的 base
  return '/docs';
}

/**
 * 解析路径，添加基础路径前缀
 */
export function resolvePath(path: string): string {
  const base = getBasePath();
  if (path.startsWith('/')) {
    // 确保路径格式正确，避免双斜杠
    return `${base}${path}`.replace(/\/+/g, '/');
  }
  return path;
}

/**
 * 获取当前微应用的完整 URL
 */
export function getMicroAppUrl(): string {
  if (isInIcestark()) {
    return window.location.href;
  }
  return window.location.href;
}

/**
 * 检查当前是否在微应用环境中运行
 */
export function checkIsInMicroApp(): boolean {
  return isInIcestark();
}
