// 家具动了之后，场景里的其他东西怎么跟上（不依赖 three.js / DOM，可单测）：
//   - 寻路障碍、交互点按最新位置重算；她正在走的话当场重新寻路（拖动时实时避让）；
//   - 她正在用（或正走向）的家具被拖起来：先起身 / 停下等着，松手后走到新位置重新就位，不会坐在空气里；
//   - 拖动中路被暂时挡住：先停下，松手后重新安排；
//   - 一次拖动（按下到松手）算一步撤销。
// 画面上的事（选中框、鼠标、把家具模型摆到新位置）在 scene/dragController.ts 和 main.ts。

import type { CharacterAgent } from '../character/agent';
import type { RoomsConfig } from '../config/types';
import type { Director } from '../director/director';
import type { StagePerformer } from '../director/stagePerformer';
import { CHARACTER_RADIUS, furnitureObstacles, wallObstacles, type Obstacle, type Pathfinder } from '../nav/pathfinder';
import { indexAnchors, type AnchorIndex } from '../scene/anchors';
import type { Blocker, LayoutSnapshot, LayoutStore, PlaceIssue } from './layoutStore';
import type { Vec2 } from '../config/types';

export interface StageLayoutDeps {
  store: LayoutStore;
  rooms: RoomsConfig;
  pathfinder: Pathfinder;
  agent: CharacterAgent;
  performer: StagePerformer;
  director: Director;
  characterId: string;
  /** 交互点重算后交给外面（演员每次现取） */
  setAnchors: (idx: AnchorIndex) => void;
  /** 家具位置变了：把这些家具的模型摆到新位置 */
  onMoved?: (ids: string[]) => void;
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

export class StageLayout {
  private walls: Obstacle[];
  private dragBefore: LayoutSnapshot | null = null;
  private dragIds: string[] = [];
  /** 松手后需要让导演重新安排一次（她被叫起来了，或路被挡停了） */
  private needRelocate = false;

  constructor(private d: StageLayoutDeps) {
    this.walls = wallObstacles(d.rooms);
    this.refreshNav(false);
  }

  /** 人：家具不能压到她身上 */
  blocker(): Blocker {
    return { position: [this.d.agent.position[0], this.d.agent.position[1]], radius: CHARACTER_RADIUS };
  }

  get dragging() {
    return this.dragBefore !== null;
  }

  // ───────── 拖动（按下 → 移动若干次 → 松手） ─────────

  beginDrag(id: string) {
    this.dragBefore = this.d.store.snapshot();
    this.dragIds = this.d.store.groupOf(id).map((it) => it.id);
    this.needRelocate = false;
    if (this.d.performer.usesFurniture(this.dragIds)) {
      this.d.performer.suspend();
      this.needRelocate = true;
    }
  }

  /** 拖动中的一步：能放下就挪过去并实时更新障碍 / 路径；放不下原地不动，返回原因 */
  dragTo(id: string, target: Vec2): PlaceIssue | null {
    const before = this.d.store.item(id)?.position;
    const issue = this.d.store.tryMove(id, target, this.blocker());
    const now = this.d.store.item(id)?.position;
    if (!issue && before && now && (before[0] !== now[0] || before[1] !== now[1])) {
      this.d.onMoved?.(this.dragIds);
      this.refreshNav(true);
    }
    return issue;
  }

  /** 松手：记一步撤销、保存；需要的话让她去新位置重新就位。返回布局有没有变。 */
  endDrag(): boolean {
    const before = this.dragBefore;
    const ids = this.dragIds;
    this.dragBefore = null;
    this.dragIds = [];
    if (!before) return false;
    const changed = this.d.store.commit(before);
    if (changed) this.d.log?.('info', '[layout] 家具已挪动', { ids, to: ids.map((i) => this.d.store.item(i)?.position) });
    this.settle(ids);
    return changed;
  }

  // ───────── 一步到位的操作 ─────────

  /** 旋转（R 键 / 右键菜单）。拖动途中也可以转；不在拖动时自己算一步撤销。 */
  rotate(id: string, deg = 90): PlaceIssue | null {
    const ids = this.d.store.groupOf(id).map((it) => it.id);
    const standalone = !this.dragging;
    const before = this.d.store.snapshot();
    if (standalone && this.d.performer.usesFurniture(ids)) {
      this.d.performer.suspend();
      this.needRelocate = true;
    }
    const issue = this.d.store.tryRotate(id, deg, this.blocker());
    if (!issue) {
      this.d.onMoved?.(ids);
      this.refreshNav(!standalone);
      if (standalone) this.d.store.commit(before);
      this.d.log?.('info', '[layout] 家具已旋转', { ids, rotation: this.d.store.item(id)?.rotation });
    }
    if (standalone) this.settle(ids);
    return issue;
  }

  undo(): string[] {
    return this.after(this.d.store.undo(), '撤销');
  }

  reset(): string[] {
    return this.after(this.d.store.reset(), '恢复默认');
  }

  private after(changed: string[], what: string): string[] {
    if (changed.length === 0) return changed;
    this.d.log?.('info', `[layout] ${what}`, { ids: changed });
    this.d.onMoved?.(changed);
    this.refreshNav(false);
    // 家具可能被挪回到她站的地方：撤销 / 恢复默认不拦，她会自己走出来
    this.settle(changed);
    return changed;
  }

  // ───────── 内部 ─────────

  /** 按最新布局重算障碍与交互点；她正在走就重新寻路 */
  private refreshNav(live: boolean) {
    this.d.pathfinder.setObstacles([...this.walls, ...furnitureObstacles(this.d.store.items)]);
    this.d.setAnchors(indexAnchors(this.d.store.items));
    if (!this.d.agent.repath(live) && live) this.needRelocate = true;
  }

  /** 操作结束：她的目的地受影响（或之前被叫停了）就重新就位 */
  private settle(ids: string[]) {
    if (!this.dragging) this.refreshNav(false);
    if (this.needRelocate || this.d.performer.isSuspended || this.d.performer.usesFurniture(ids)) {
      this.needRelocate = false;
      this.d.director.relocate(this.d.characterId);
    }
  }
}
