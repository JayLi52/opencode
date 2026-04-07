// 存储微应用相关的 DOM 元素和状态
let microAppState: {
  observer?: MutationObserver;
  originalTitle?: string;
} = {};

export function render(container: HTMLElement) {
  // 保存原始标题
  microAppState.originalTitle = document.title;
  
  // 创建微应用内容容器
  const contentWrapper = document.createElement('div');
  contentWrapper.id = 'opencode-web-content';
  contentWrapper.style.width = '100%';
  contentWrapper.style.height = '100%';
  contentWrapper.style.overflow = 'auto';
  container.appendChild(contentWrapper);
  
  // 监听 DOM 变化，处理 Astro 客户端 hydration
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            // 处理新添加的元素
            handleAddedElement(node, contentWrapper);
          }
        });
      }
    });
  });
  
  observer.observe(container, { childList: true, subtree: true });
  microAppState.observer = observer;
  
  // 触发 Astro 页面加载完成事件
  window.dispatchEvent(new CustomEvent('opencode-web:mounted', { 
    detail: { container } 
  }));
}

function handleAddedElement(node: HTMLElement, container: HTMLElement) {
  // 将 body 下的样式和脚本移动到容器内
  if (node.tagName === 'STYLE' || node.tagName === 'LINK') {
    const clonedNode = node.cloneNode(true) as HTMLElement;
    clonedNode.setAttribute('data-micro-app', 'opencode-web');
    container.appendChild(clonedNode);
  }
}

export function dispose(container: HTMLElement) {
  // 断开 MutationObserver
  if (microAppState.observer) {
    microAppState.observer.disconnect();
    delete microAppState.observer;
  }
  
  // 恢复原始标题
  if (microAppState.originalTitle) {
    document.title = microAppState.originalTitle;
    delete microAppState.originalTitle;
  }
  
  // 清理 DOM
  const contentWrapper = container.querySelector('#opencode-web-content');
  if (contentWrapper) {
    contentWrapper.remove();
  }
  
  // 清理微应用相关的样式和脚本
  const microAppElements = document.querySelectorAll('[data-micro-app="opencode-web"]');
  microAppElements.forEach((el) => el.remove());
  
  // 触发卸载完成事件
  window.dispatchEvent(new CustomEvent('opencode-web:unmounted'));
}
