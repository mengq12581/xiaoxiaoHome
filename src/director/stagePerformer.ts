// 演员：把导演派下来的一场演出落到场景里的角色身上。
// 选交互点 → 走过去 → 坐 / 躺 / 站好 → 播活动动作 → 摆道具。全部由 activities.json 的字段驱动：
//   anchor       去哪类交互点（可多选；prefer_anchor 优先，其余按路程近的来）
//   anim         到位后的动作名；以 lie_ 开头的要躺下
//   face = path  没有固定地点，在导航点之间闲逛
//   props        到位后出现的道具
// 所以新增一个活动只要加配置和一个交互点，这里和导演都不用改。

import type { CharacterAgent, SeatPose } from '../character/agent';
import type { Vec2 } from '../config/types';
import { pathLength, type Pathfinder } from '../nav/pathfinder';
import type { AnchorIndex, StandSpot } from '../scene/anchors';
import type { PerformPlan, Performer } from './director';

export interface PropSink {
  /** 当前应该出现的道具名（其余的收起） */
  set(props: string[]): void;
}

type Target = { kind: 'seat'; seat: SeatPose; lie: boolean } | { kind: 'stand'; spot: StandSpot } | { kind: 'stay' } | { kind: 'wander' };

export class StagePerformer implements Performer {
  private plan: PerformPlan | null = null;
  private target: Target = { kind: 'stay' };
  private propsShown = false;
  private seed = 987654321;

  constructor(
    private agent: CharacterAgent,
    private pf: Pathfinder,
    /** 每次现取：家具被拖动后交互点会变（M5） */
    private anchors: () => AnchorIndex,
    private navNodes: () => Vec2[],
    private props: PropSink,
    private log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {}

  begin(plan: PerformPlan) {
    this.plan = plan;
    this.propsShown = false;
    this.props.set([]);
    this.agent.setAnim(null);
    this.target = this.resolve(plan);
    const t = this.target;
    switch (t.kind) {
      case 'seat':
        if (t.lie) this.agent.lieAt(t.seat);
        else this.agent.sitAt(t.seat);
        break;
      case 'stand':
        this.agent.standAt(t.spot.plan, t.spot.headingDeg);
        break;
      case 'wander':
        this.strollOnce();
        break;
      case 'stay':
        // 原地：坐着 / 躺着的先起来
        if (this.agent.seat) this.agent.standUp();
        break;
    }
    this.agent.setAnim(plan.spec.anim);
  }

  get failed() {
    return this.agent.failed && this.target.kind !== 'wander';
  }

  get arrived(): boolean {
    const a = this.agent;
    const t = this.target;
    if (!this.plan || a.failed) return false;
    let there = false;
    switch (t.kind) {
      case 'seat':
        there = a.settled && a.seat?.id === t.seat.id && a.state === (t.lie ? 'lying' : 'seated');
        break;
      case 'stand':
        there = a.settled && a.state === 'idle' && Math.hypot(a.position[0] - t.spot.plan[0], a.position[1] - t.spot.plan[1]) < 0.05;
        break;
      case 'stay':
        there = a.settled && a.state === 'idle';
        break;
      case 'wander':
        there = a.state === 'walking' || a.state === 'turning' || a.state === 'idle';
        break;
    }
    return there;
  }

  /** 每帧调用：到位后摆道具；闲逛走完一轮接着走 */
  update() {
    if (!this.plan) return;
    if (!this.propsShown && this.arrived && this.target.kind !== 'wander') {
      this.propsShown = true;
      this.props.set(this.plan.spec.props ?? []);
    }
    if (this.target.kind === 'wander' && this.agent.settled) this.strollOnce();
  }

  // ───────── 选地方 ─────────

  private resolve(plan: PerformPlan): Target {
    const spec = plan.spec;
    if (spec.anchor === null) return spec.face === 'path' ? { kind: 'wander' } : { kind: 'stay' };
    const types = Array.isArray(spec.anchor) ? [...spec.anchor] : [spec.anchor];
    if (spec.prefer_anchor) types.sort((a, b) => Number(b === spec.prefer_anchor) - Number(a === spec.prefer_anchor));
    const idx = this.anchors();
    const lie = spec.anim.startsWith('lie_');
    // 已经坐在 / 站在其中一个上：不挪窝（同一张桌子上「用电脑」换「写笔记」不用站起来再坐下）
    for (const type of types) {
      for (const key of idx.byType.get(type) ?? []) {
        if (this.agent.seat?.id === key) return { kind: 'seat', seat: idx.seats.get(key)!, lie };
      }
    }
    for (const type of types) {
      let best: { target: Target; cost: number } | null = null;
      for (const key of idx.byType.get(type) ?? []) {
        const seat = idx.seats.get(key);
        const spot = idx.stands.get(key);
        const goal = seat?.approach ?? spot?.plan;
        if (!goal) continue;
        const res = this.pf.findPath(this.agent.position, goal);
        if (!res.ok) continue;
        const cost = pathLength(res.path);
        const target: Target = seat ? { kind: 'seat', seat, lie } : { kind: 'stand', spot: spot! };
        if (!best || cost < best.cost) best = { target, cost };
      }
      if (best) return best.target;
    }
    // 一个都走不到：交给 agent 去走第一个，让它报「寻路失败」
    for (const type of types) {
      const key = (idx.byType.get(type) ?? [])[0];
      if (!key) continue;
      const seat = idx.seats.get(key);
      if (seat) return { kind: 'seat', seat, lie };
      const spot = idx.stands.get(key);
      if (spot) return { kind: 'stand', spot };
    }
    this.log('warn', '活动的交互点在场景里不存在，原地待着', { activity: plan.activity, anchor: spec.anchor });
    return { kind: 'stay' };
  }

  // ───────── 闲逛 ─────────

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  /** 随机挑 1～3 个走得到的导航点，依次走过去，每到一处停 2～5 秒看看 */
  private strollOnce() {
    const nodes = this.navNodes().filter((n) => {
      if (Math.hypot(n[0] - this.agent.position[0], n[1] - this.agent.position[1]) < 0.8) return false;
      return this.pf.findPath(this.agent.position, n).ok;
    });
    if (nodes.length === 0) return;
    const count = 1 + Math.floor(this.rand() * 3);
    const stops: { goal: Vec2; pause: number }[] = [];
    for (let i = 0; i < count && nodes.length > 0; i++) {
      const [goal] = nodes.splice(Math.floor(this.rand() * nodes.length), 1);
      stops.push({ goal, pause: 2 + this.rand() * 3 });
    }
    this.agent.stroll(stops);
  }
}
