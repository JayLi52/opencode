import { isInIcestark, setLibraryName } from '@ice/stark-app';
import { render, dispose } from './app';
import './styles/micro-app.css';

interface LifecycleProps {
  container: HTMLElement;
  customProps?: object;
}

// 微应用生命周期 - 挂载
export function mount(props: LifecycleProps) {
  const { container } = props;
  
  // 添加命名空间类名
  container.classList.add('opencode-web-micro-app');
  
  render(container);
}

// 微应用生命周期 - 卸载
export function unmount(props: LifecycleProps) {
  const { container } = props;
  
  dispose(container);
  
  // 移除命名空间类名
  container.classList.remove('opencode-web-micro-app');
}

// 设置库名称，与构建配置一致
setLibraryName('OpenCodeWeb');

// 独立运行模式（非微应用环境）
if (!isInIcestark()) {
  const container = document.getElementById('app');
  if (container) {
    container.classList.add('opencode-web-micro-app');
    render(container);
  }
}
