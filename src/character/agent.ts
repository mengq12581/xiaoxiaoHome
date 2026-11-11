// 角色走位与基础动作：寻路行走、原地转身、坐下 / 起身（带过渡），以及待机呼吸、走路摆臂摆腿。
// 规则（docs/状态与动作映射表.md §五）：
// - 走位沿寻路结果逐段前进，永远朝下一个路点直线移动，不瞬移；
// - 转角太大先原地转身（小碎步）再走；
// - 站→坐：先到站位，转身朝向座位朝向，再用 1.2 秒坐下；坐→站：1.0 秒起身回到站位；
// - 坐下 / 起身过程中不接受新的走位指令，新指令排队，过渡结束后执行；
// - 寻路无解：原地停下并写警告。

import type { Vec2 } from '../config/types';
import type { Pathfinder } from '../nav/pathfinder';
import { REF_HIP_HEIGHT, type CharacterRig } from './rig';

export interface SeatPose {
  /** 例如 desk:desk_seat */
  id: string;
  /** 坐好后的位置（平面） */
  plan: Vec2;
  /** 座面高度（米，世界尺度） */
  height: number;
  /** 坐好后面朝的方向（平面角，度，0 = +x，逆时针） */
  headingDeg: number;
  /** 坐下前的站位 */
  approach: Vec2;
}

export type AgentState = 'idle' | 'walking' | 'turning' | 'sitting_down' | 'seated' | 'standing_up';

type Step =
  | { kind: 'walk'; goal: Vec2 }
  | { kind: 'turn'; headingDeg: number }
  | { kind: 'sit'; seat: SeatPose }
  | { kind: 'stand' };

export type LogFn = (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;

export interface AgentOptions {
  /** 行走速度 m/s */
  speed: number;
  /** 转身角速度 度/s */
  turnRateDeg: number;
  /** 转角超过这个值先原地转身（度） */
  turnInPlaceDeg: number;
  sitDuration: number;
  standDuration: number;
  log: LogFn;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  speed: 0.75,
  turnRateDeg: 300,
  turnInPlaceDeg: 50,
  sitDuration: 1.2,
  standDuration: 1.0,
  log: () => {},
};

/** 一个完整步态周期（左右各一步）在参考身高下走过的距离 */
const STRIDE = 0.38;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
/** 把角度差归一到 (-180, 180] */
export const angleDiff = (to: number, from: number) => {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class CharacterAgent {
  position: Vec2;
  headingDeg: number;
  state: AgentState = 'idle';
  seat: SeatPose | null = null;
  /** 当前路径（含起点），调试显示用 */
  path: Vec2[] = [];

  private opts: AgentOptions;
  private wp = 0;
  private queue: Step[] = [];
  private pending: Step[] | null = null;
  private turnTarget = 0;
  private tween = { t: 0, dur: 1, from: [0, 0] as Vec2, to: [0, 0] as Vec2, seat: null as SeatPose | null };
  private time = 0;
  private phase = 0;
  private walkAmt = 0;
  private seatAmt = 0;
  private moving = false;
  private blinkWait = 2;
  private blinkDouble = false;
  private eye: 0 | 1 | 2 = 0;
  private seed = 20261111;

  constructor(
    readonly rig: CharacterRig,
    private pf: Pathfinder,
    spawn: Vec2,
    headingDeg = -90,
    opts: Partial<AgentOptions> = {},
  ) {
    this.opts = { ...DEFAULT_AGENT_OPTIONS, ...opts };
    this.position = [spawn[0], spawn[1]];
    this.headingDeg = headingDeg;
    this.applyPose();
  }

  /** 坐姿权重 0～1（接触阴影等用） */
  get sitWeight() {
    return this.seatAmt;
  }

  /** 当前（或正在坐下 / 起身的）座面高度，米 */
  get seatHeight() {
    return (this.tween.seat ?? this.seat)?.height ?? 0;
  }

  get busy() {
    return this.state !== 'idle' && this.state !== 'seated';
  }

  /** 走到某点（站着） */
  walkTo(goal: Vec2) {
    this.command([{ kind: 'walk', goal }]);
  }

  /** 走到座位前、转身、坐下 */
  sitAt(seat: SeatPose) {
    if (this.state === 'seated' && this.seat?.id === seat.id) return;
    this.command([
      { kind: 'walk', goal: seat.approach },
      { kind: 'turn', headingDeg: seat.headingDeg },
      { kind: 'sit', seat },
    ]);
  }

  /** 走到某点后转向指定方向站着（窗边站位等） */
  standAt(goal: Vec2, headingDeg: number) {
    this.command([
      { kind: 'walk', goal },
      { kind: 'turn', headingDeg },
    ]);
  }

  standUp() {
    this.command([]);
  }

  private command(steps: Step[]) {
    if (this.state === 'sitting_down' || this.state === 'standing_up') {
      this.pending = steps;
      this.opts.log('info', '过渡中，新指令排队', { state: this.state });
      return;
    }
    this.queue = this.state === 'seated' ? [{ kind: 'stand' }, ...steps] : steps;
    this.startNext();
  }

  private startNext(): void {
    const step = this.queue.shift();
    if (!step) {
      this.state = this.seat ? 'seated' : 'idle';
      this.path = [];
      return;
    }
    switch (step.kind) {
      case 'walk': {
        const res = this.pf.findPath(this.position, step.goal);
        if (!res.ok) {
          this.opts.log('warn', '寻路失败，原地停下', { from: this.position, to: step.goal, reason: res.reason });
          this.queue = [];
          this.path = [];
          this.state = 'idle';
          return;
        }
        this.path = res.path;
        this.wp = 1;
        this.state = 'walking';
        this.opts.log('info', '开始走位', { to: step.goal, waypoints: res.path.length });
        if (res.path.length < 2) this.startNext();
        return;
      }
      case 'turn':
        this.turnTarget = step.headingDeg;
        this.state = 'turning';
        return;
      case 'sit':
        this.tween = { t: 0, dur: this.opts.sitDuration, from: [...this.position] as Vec2, to: step.seat.plan, seat: step.seat };
        this.state = 'sitting_down';
        return;
      case 'stand': {
        const seat = this.seat;
        if (!seat) {
          this.startNext();
          return;
        }
        this.tween = { t: 0, dur: this.opts.standDuration, from: [...this.position] as Vec2, to: seat.approach, seat };
        this.state = 'standing_up';
        return;
      }
    }
  }

  /** 过渡结束：有排队指令就接着执行，否则继续原队列 */
  private finishTransition() {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.queue = this.state === 'seated' ? [{ kind: 'stand' }, ...p] : p;
    }
    this.startNext();
  }

  update(dt: number) {
    this.time += dt;
    this.moving = false;
    switch (this.state) {
      case 'walking':
        this.updateWalk(dt);
        break;
      case 'turning':
        if (this.turnToward(this.turnTarget, dt)) this.startNext();
        else this.phase += dt * 5;
        break;
      case 'sitting_down':
      case 'standing_up':
        this.updateTween(dt);
        break;
    }
    this.applyPose(dt);
  }

  /** 朝目标角转一步，返回是否已到位 */
  private turnToward(target: number, dt: number): boolean {
    const diff = angleDiff(target, this.headingDeg);
    const max = this.opts.turnRateDeg * dt;
    if (Math.abs(diff) <= max) {
      this.headingDeg = ((target % 360) + 360) % 360;
      return true;
    }
    this.headingDeg = (((this.headingDeg + Math.sign(diff) * max) % 360) + 360) % 360;
    return false;
  }

  private updateWalk(dt: number) {
    const target = this.path[this.wp];
    const dx = target[0] - this.position[0];
    const dy = target[1] - this.position[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) {
      this.nextWaypoint();
      return;
    }
    const desired = deg(Math.atan2(dy, dx));
    this.turnToward(desired, dt);
    const diff = Math.abs(angleDiff(desired, this.headingDeg));
    if (diff > this.opts.turnInPlaceDeg) {
      // 原地转身：小碎步
      this.phase += dt * 5;
      return;
    }
    const factor = Math.cos(rad(diff));
    const step = Math.min(this.opts.speed * factor * dt, d);
    this.position = [this.position[0] + (dx / d) * step, this.position[1] + (dy / d) * step];
    this.phase += (step / (STRIDE * this.rig.scale)) * Math.PI * 2;
    this.moving = step > 0;
    if (d - step < 1e-4) {
      this.position = [target[0], target[1]];
      this.nextWaypoint();
    }
  }

  private nextWaypoint() {
    this.wp++;
    if (this.wp >= this.path.length) {
      this.opts.log('info', '到达', { at: this.position });
      this.startNext();
    }
  }

  private updateTween(dt: number) {
    const tw = this.tween;
    tw.t = Math.min(tw.dur, tw.t + dt);
    const k = ease(tw.t / tw.dur);
    this.position = [lerp(tw.from[0], tw.to[0], k), lerp(tw.from[1], tw.to[1], k)];
    this.seatAmt = this.state === 'sitting_down' ? k : 1 - k;
    if (tw.t >= tw.dur) {
      if (this.state === 'sitting_down') {
        this.seat = tw.seat;
        this.state = 'seated';
        this.seatAmt = 1;
        this.opts.log('info', '坐下', { seat: tw.seat?.id });
      } else {
        this.opts.log('info', '起身', { seat: this.seat?.id });
        this.seat = null;
        this.state = 'idle';
        this.seatAmt = 0;
      }
      this.finishTransition();
    }
  }

  /** 眨眼：间隔 2.5～6 秒随机，偶尔连眨两下；半闭 → 闭 → 半闭 → 睁 */
  private updateBlink(dt: number) {
    this.blinkWait -= dt;
    if (this.blinkWait > 0) return;
    const t = -this.blinkWait;
    const seq = this.blinkDouble ? [0.05, 0.13, 0.18, 0.26, 0.34, 0.39] : [0.05, 0.13, 0.18];
    let eye: 0 | 1 | 2 = 0;
    if (t < seq[0]) eye = 1;
    else if (t < seq[1]) eye = 2;
    else if (t < seq[2]) eye = 1;
    else if (this.blinkDouble && t < seq[3]) eye = 0;
    else if (this.blinkDouble && t < seq[4]) eye = 2;
    else if (this.blinkDouble && t < seq[5]) eye = 1;
    else {
      this.blinkWait = 2.5 + this.rand() * 3.5;
      this.blinkDouble = this.rand() < 0.2;
    }
    if (eye !== this.eye) {
      this.eye = eye;
      this.rig.setEyes(eye);
    }
  }

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  /** 把当前状态写到骨架上 */
  private applyPose(dt = 0) {
    const r = this.rig;
    r.root.position.set(this.position[0], 0, -this.position[1]);
    r.root.rotation.y = rad(this.headingDeg) + Math.PI / 2;
    this.updateBlink(dt);
    r.setSitBlend(this.seatAmt);

    const walkGoal = this.state === 'walking' ? (this.moving ? 1 : 0.45) : this.state === 'turning' ? 0.45 : 0;
    this.walkAmt += (walkGoal - this.walkAmt) * Math.min(1, dt * 8);
    if (this.state === 'seated') this.seatAmt = 1;
    else if (this.state === 'idle' || this.state === 'walking' || this.state === 'turning') this.seatAmt = 0;

    const k = this.seatAmt; // 坐姿权重
    const w = this.walkAmt; // 走路权重
    const calm = (1 - w) * (1 - k); // 站立待机权重
    const t = this.time;
    const swing = Math.sin(this.phase);
    const breath = Math.sin(t * 2.3);
    const sway = Math.sin(t * 1.35); // 重心左右缓慢移动（约 4.6 秒一个来回）

    // 胯：高度、左右重心、走路上下起伏
    const seatH = (this.tween.seat ?? this.seat)?.height ?? REF_HIP_HEIGHT * r.scale;
    r.body.position.y = lerp(REF_HIP_HEIGHT, seatH / r.scale, k) + 0.012 * w * Math.abs(Math.cos(this.phase));
    r.body.position.x = 0.007 * calm * sway;
    r.body.rotation.z = 0.022 * calm * sway;

    // 腿：站立时脚基本不动（补偿胯的倾斜）；走路摆腿 + 抬腿时屈膝；坐下时膝盖并拢、一前一后
    r.legL.rotation.set(
      -1.42 * k + 0.5 * w * swing,
      -0.1 * k,
      -0.022 * calm * sway,
    );
    r.legR.rotation.set(
      -1.3 * k - 0.5 * w * swing,
      0.12 * k,
      -0.022 * calm * sway,
    );
    r.shinL.rotation.x = 1.5 * k + 0.55 * w * Math.max(0, -Math.sin(this.phase - 0.5));
    r.shinR.rotation.x = 1.18 * k + 0.55 * w * Math.max(0, Math.sin(this.phase - 0.5));

    // 上身：呼吸起伏、走路略前倾、坐下略前倾放松、站立时与胯反向轻摆
    r.torso.rotation.x = 0.06 * w + 0.12 * k;
    r.torso.rotation.z = -0.03 * calm * sway;
    r.torso.scale.y = 1 + 0.013 * breath;

    // 手臂：自然下垂略外张；走路前后摆；坐下时手放松搭在膝上（左右不对称）
    const roll = 0.22 + 0.012 * breath;
    r.armL.rotation.set(-0.38 * w * swing - 0.56 * k, 0, roll * (1 - k) + 0.07 * k);
    r.armR.rotation.set(0.38 * w * swing - 0.64 * k, 0, -roll * (1 - k) - 0.05 * k);
    r.foreL.rotation.x = -0.08 - 0.15 * w * Math.max(0, swing) - 0.5 * k;
    r.foreR.rotation.x = -0.08 - 0.15 * w * Math.max(0, -swing) - 0.36 * k;

    // 头：待机时偶尔左右看看；坐着微微歪头、略低头
    r.head.rotation.x = 0.05 * k + 0.012 * breath * (1 - w);
    r.head.rotation.y = 0.1 * (1 - w) * Math.sin(t * 0.35);
    r.head.rotation.z = 0.02 * calm * sway + 0.06 * k + 0.02 * (1 - w) * Math.sin(t * 0.9);
  }
}
