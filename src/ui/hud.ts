// 屏幕叠加层：操作提示、视角读数、配置错误遮罩。

import type { ConfigIssue } from '../config/validate';

export interface Hud {
  setStats(text: string): void;
  onReset(fn: () => void): void;
}

export function createHud(root: HTMLElement, subtitle: string): Hud {
  const panel = document.createElement('div');
  panel.className = 'hud hud-panel';
  panel.innerHTML = `
    <div class="hud-title">小家 3D</div>
    <div class="hud-sub">${subtitle}</div>
    <ul class="hud-help">
      <li><b>左键拖动</b> 环绕旋转</li>
      <li><b>滚轮</b> 缩放</li>
      <li><b>双击家具</b> 选中，按住拖动</li>
      <li><b>R / 右键</b> 旋转 90°</li>
      <li><b>Ctrl+Z</b> 撤销 · <b>Esc</b> 取消选中</li>
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

/** 屏幕下方的短提示（放不下、已撤销、已导出……），几秒后自动消失 */
export function createToast(root: HTMLElement): (msg: string) => void {
  const el = document.createElement('div');
  el.className = 'hud toast';
  root.appendChild(el);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (msg) => {
    el.textContent = msg;
    el.classList.add('show');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('show'), 2600);
  };
}

export interface LayoutBar {
  /** 按钮可用状态 */
  set(state: { canUndo: boolean; isDefault: boolean }): void;
}

/** 右上角的布局按钮：撤销、恢复默认、导出布局 JSON（docs/数据与接口约定.md §5） */
export function createLayoutBar(root: HTMLElement, actions: { undo(): void; reset(): void; exportJson(): void }): LayoutBar {
  const bar = document.createElement('div');
  bar.className = 'hud layout-bar';
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    bar.appendChild(b);
    return b;
  };
  const undo = mk('撤销', actions.undo);
  const reset = mk('恢复默认', actions.reset);
  mk('导出布局 JSON', actions.exportJson);
  root.appendChild(bar);
  return {
    set: (s) => {
      undo.disabled = !s.canUndo;
      reset.disabled = s.isDefault;
    },
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
