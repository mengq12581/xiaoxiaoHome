// 开发态走位演示面板（只在 npm run dev 下出现）。M3 起角色由状态驱动，这里只是 M2 的验收工具。

export interface DevAction {
  label: string;
  run: () => void;
}

export interface DevPanel {
  setStatus(text: string): void;
}

export function createDevPanel(root: HTMLElement, title: string, actions: DevAction[]): DevPanel {
  const panel = document.createElement('div');
  panel.className = 'hud dev-panel';
  const h = document.createElement('div');
  h.className = 'dev-title';
  h.textContent = title;
  const list = document.createElement('div');
  list.className = 'dev-actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-btn';
    b.textContent = a.label;
    b.addEventListener('click', a.run);
    list.appendChild(b);
  }
  const status = document.createElement('div');
  status.className = 'dev-status';
  panel.append(h, list, status);
  root.appendChild(panel);
  return {
    setStatus: (t) => {
      status.textContent = t;
    },
  };
}
