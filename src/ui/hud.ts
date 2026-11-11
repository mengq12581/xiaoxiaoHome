// 屏幕叠加层：操作提示、视角读数、配置错误遮罩。

import type { ConfigIssue } from '../config/validate';

export interface Hud {
  setStats(text: string): void;
  onReset(fn: () => void): void;
}

export function createHud(root: HTMLElement): Hud {
  const panel = document.createElement('div');
  panel.className = 'hud hud-panel';
  panel.innerHTML = `
    <div class="hud-title">小家 3D</div>
    <div class="hud-sub">v0.1 · M1 场景与相机</div>
    <ul class="hud-help">
      <li><b>左键拖动</b> 环绕旋转</li>
      <li><b>滚轮</b> 缩放</li>
    </ul>
    <button class="hud-btn" type="button">复位视角</button>
  `;
  root.appendChild(panel);

  const stats = document.createElement('div');
  stats.className = 'hud hud-stats';
  root.appendChild(stats);

  const btn = panel.querySelector('button')!;
  return {
    setStats: (t) => {
      stats.textContent = t;
    },
    onReset: (fn) => btn.addEventListener('click', fn),
  };
}

export function showConfigErrors(root: HTMLElement, issues: ConfigIssue[]) {
  const box = document.createElement('div');
  box.className = 'config-error';
  const h = document.createElement('h2');
  h.textContent = `配置校验失败（${issues.length} 处）`;
  const ul = document.createElement('ul');
  for (const i of issues) {
    const li = document.createElement('li');
    const file = document.createElement('code');
    file.textContent = `${i.file}  ${i.path}`;
    li.append(file, document.createTextNode(`：${i.message}`));
    ul.appendChild(li);
  }
  const tip = document.createElement('p');
  tip.textContent = '改好 config/ 下对应文件并保存后会自动重新加载。';
  box.append(h, ul, tip);
  root.appendChild(box);
}
