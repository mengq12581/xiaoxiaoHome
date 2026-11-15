// 家具拖动的交互（docs/PRD.md F-07）：
//   双击家具 → 选中（套一个半透明的框）；按住选中的家具拖 → 沿地面移动；
//   R 键或右键菜单 → 旋转 90°；Ctrl+Z → 撤销；Esc 或双击空地 → 取消选中。
// 这里只管鼠标、键盘和选中框；能不能放、人物怎么配合在 layout/ 下。

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec2 } from '../config/types';
import { ISSUE_TEXT, type LayoutStore, type PlaceIssue } from '../layout/layoutStore';
import type { StageLayout } from '../layout/stageLayout';
import type { FurnitureView } from './furniture';

/** 拖动时位置吸附的步长（米） */
const SNAP = 0.05;
const COLOR_OK = 0xe38d5f;
const COLOR_BAD = 0xd9534f;

export interface DragDeps {
  dom: HTMLElement;
  /** 菜单挂在哪个容器里 */
  overlayRoot: HTMLElement;
  camera: THREE.Camera;
  controls: OrbitControls;
  views: FurnitureView[];
  store: LayoutStore;
  layout: StageLayout;
  toast: (msg: string) => void;
  /** 选中 / 布局有变化时通知界面（按钮可用状态等） */
  onChange?: () => void;
}

interface Overlay {
  id: string;
  root: THREE.Group;
  fill: THREE.MeshBasicMaterial;
  line: THREE.LineBasicMaterial;
}

export class DragController {
  selectedId: string | null = null;
  private overlays: Overlay[] = [];
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private drag: { id: string; offset: Vec2; pointerId: number; moved: boolean } | null = null;
  private badUntil = 0;
  private menu: HTMLElement | null = null;
  private lastIssue: PlaceIssue | null = null;
  private off: (() => void)[] = [];

  constructor(private d: DragDeps) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(d.dom, 'dblclick', (e: MouseEvent) => this.onDblClick(e));
    // capture：要赶在轨道相机之前决定这次按下是「拖家具」还是「转视角」
    on(d.dom, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e), { capture: true });
    on(d.dom, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    on(d.dom, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    on(d.dom, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e));
    on(d.dom, 'contextmenu', (e: MouseEvent) => this.onContextMenu(e));
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e));
    on(window, 'pointerdown', (e: PointerEvent) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    });
  }

  dispose() {
    for (const f of this.off) f();
    this.select(null);
  }

  /** 选中框（不参与环境光遮蔽） */
  get overlayObjects(): THREE.Object3D[] {
    return this.overlays.map((o) => o.root);
  }

  /** 每帧调用：放不下时选中框闪红 */
  update(nowMs: number) {
    const bad = nowMs < this.badUntil;
    for (const o of this.overlays) {
      const c = bad ? COLOR_BAD : COLOR_OK;
      o.fill.color.setHex(c);
      o.line.color.setHex(c);
    }
  }

  // ───────── 选中 ─────────

  select(id: string | null) {
    if (id === this.selectedId) return;
    for (const o of this.overlays) {
      o.root.removeFromParent();
      o.fill.dispose();
      o.line.dispose();
      o.root.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
    }
    this.overlays = [];
    this.selectedId = id;
    this.closeMenu();
    if (id) {
      for (const it of this.d.store.groupOf(id)) {
        const view = this.d.views.find((v) => v.item.id === it.id);
        if (!view) continue;
        const primary = it.id === id;
        const [w, dd, h] = it.size;
        const geo = new THREE.BoxGeometry(w + 0.08, h + 0.08, dd + 0.08);
        const fill = new THREE.MeshBasicMaterial({ color: COLOR_OK, transparent: true, opacity: primary ? 0.16 : 0.08, depthWrite: false });
        const line = new THREE.LineBasicMaterial({ color: COLOR_OK, transparent: true, opacity: primary ? 0.95 : 0.5 });
        const root = new THREE.Group();
        root.name = 'selection';
        const box = new THREE.Mesh(geo, fill);
        box.renderOrder = 4;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), line);
        edges.renderOrder = 5;
        root.add(box, edges);
        root.position.y = h / 2;
        view.group.add(root);
        this.overlays.push({ id: it.id, root, fill, line });
      }
    }
    this.d.dom.style.cursor = '';
    this.d.onChange?.();
  }

  // ───────── 拾取 ─────────

  private setRay(e: MouseEvent) {
    const r = this.d.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.d.camera);
  }

  /**
   * 鼠标下面最近的一件家具（跳过隐藏的道具）。
   * withOverlay：选中框算不算在内——按下开始拖动时算（好抓），双击选别的家具时不算（不然框会挡住后面的家具）。
   */
  private pick(e: MouseEvent, withOverlay = false): string | null {
    this.setRay(e);
    const hits = this.raycaster.intersectObjects(this.d.views.map((v) => v.group), true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      let visible = true;
      let id: string | null = null;
      while (o) {
        if (!o.visible || (!withOverlay && o.name === 'selection')) visible = false;
        if (o.userData.furnitureId) id = o.userData.furnitureId as string;
        o = o.parent;
      }
      if (visible && id) return id;
    }
    return null;
  }

  private groundPoint(e: MouseEvent): Vec2 | null {
    this.setRay(e);
    const p = this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    return p ? [p.x, -p.z] : null;
  }

  private inSelection(id: string | null) {
    return !!id && !!this.selectedId && this.d.store.groupOf(this.selectedId).some((it) => it.id === id);
  }

  // ───────── 事件 ─────────

  private onDblClick(e: MouseEvent) {
    const id = this.pick(e);
    const it = id ? this.d.store.item(id) : null;
    if (it && !it.draggable) {
      this.d.toast('这件不能挪');
      return;
    }
    this.select(it ? it.id : null);
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !this.selectedId || this.drag) return;
    const id = this.pick(e, true);
    if (!this.inSelection(id)) return;
    const g = this.groundPoint(e);
    const it = this.d.store.item(this.selectedId);
    if (!g || !it) return;
    // 这次按下是拖家具：先关掉轨道相机（它的监听器紧接着会看到 enabled = false）
    this.d.controls.enabled = false;
    this.drag = { id: this.selectedId, offset: [it.position[0] - g[0], it.position[1] - g[1]], pointerId: e.pointerId, moved: false };
    this.d.dom.setPointerCapture?.(e.pointerId);
    this.d.dom.style.cursor = 'grabbing';
    this.d.layout.beginDrag(this.selectedId);
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.drag) {
      if (this.selectedId) this.d.dom.style.cursor = this.inSelection(this.pick(e, true)) ? 'move' : '';
      return;
    }
    if (e.pointerId !== this.drag.pointerId) return;
    const g = this.groundPoint(e);
    if (!g) return;
    const snap = (v: number) => Math.round(v / SNAP) * SNAP;
    const target: Vec2 = [snap(g[0] + this.drag.offset[0]), snap(g[1] + this.drag.offset[1])];
    const issue = this.d.layout.dragTo(this.drag.id, target);
    this.drag.moved = true;
    this.flag(issue);
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.d.dom.releasePointerCapture?.(e.pointerId);
    this.drag = null;
    this.d.controls.enabled = true;
    this.d.dom.style.cursor = '';
    this.lastIssue = null;
    this.d.layout.endDrag();
    this.d.onChange?.();
  }

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const id = this.pick(e);
    const it = id ? this.d.store.item(id) : null;
    if (!it || !it.draggable) {
      this.closeMenu();
      return;
    }
    this.select(it.id);
    this.openMenu(e.clientX, e.clientY);
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
    } else if (e.key === 'Escape') {
      if (this.menu) this.closeMenu();
      else if (!this.drag) this.select(null);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r' && this.selectedId) {
      e.preventDefault();
      this.rotateSelected();
    }
  }

  // ───────── 操作 ─────────

  rotateSelected() {
    if (!this.selectedId) return;
    const issue = this.d.layout.rotate(this.selectedId, 90);
    this.flag(issue, '转不开：');
    this.d.onChange?.();
  }

  undo() {
    if (this.drag) return;
    const changed = this.d.layout.undo();
    this.d.toast(changed.length ? '已撤销一步' : '没有可以撤销的了');
    this.d.onChange?.();
  }

  reset() {
    if (this.drag) return;
    const changed = this.d.layout.reset();
    this.d.toast(changed.length ? '已恢复默认布局（Ctrl+Z 可以撤回）' : '已经是默认布局');
    this.d.onChange?.();
  }

  /** 放不下：选中框闪红，并提示原因（同一个原因拖动中只提示一次） */
  private flag(issue: PlaceIssue | null, prefix = '') {
    if (!issue) {
      this.lastIssue = null;
      this.badUntil = 0;
      return;
    }
    this.badUntil = performance.now() + 450;
    if (issue !== this.lastIssue || !this.drag) this.d.toast(prefix + ISSUE_TEXT[issue].replace(/^放不下：/, prefix ? '' : '放不下：'));
    this.lastIssue = issue;
  }

  private openMenu(x: number, y: number) {
    this.closeMenu();
    const m = document.createElement('div');
    m.className = 'ctx-menu';
    const add = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        this.closeMenu();
        fn();
      });
      m.appendChild(b);
    };
    add('旋转 90°（R）', () => this.rotateSelected());
    add('取消选中（Esc）', () => this.select(null));
    const r = this.d.overlayRoot.getBoundingClientRect();
    m.style.left = `${Math.min(x - r.left, r.width - 170)}px`;
    m.style.top = `${Math.min(y - r.top, r.height - 90)}px`;
    this.d.overlayRoot.appendChild(m);
    this.menu = m;
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }
}
