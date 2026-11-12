// 角色走位与基础动作：寻路行走、原地转身、坐下 / 起身（带过渡），以及待机呼吸、走路摆臂摆腿。
// 规则（docs/状态与动作映射表.md §五）：
// - 走位沿寻路结果逐段前进，永远朝下一个路点直线移动，不瞬移；
// - 转角太大先原地转身（小碎步）再走；
// - 站→坐：先到站位，转身朝向座位朝向，再用 1.2 秒坐下；坐→站：1.0 秒起身回到站位；
// - 坐下 / 起身过程中不接受新的走位指令，新指令排队，过渡结束后执行；
// - 躺下分两段：先坐到床上（1.2 秒），再躺平（1.3 秒）；起来反过来：先坐起（1.3 秒），再下床站好（1.0 秒）；
// - 寻路无解：原地停下并写警告。
//
// 到位之后的「活动动作」（打字、写字、晃头听歌、睡觉翻身……）是叠在基础姿势上的一层，
// 由 setAnim() 指定，只在站定 / 坐定 / 躺定时渐入，一有新指令就渐出。

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

export type AgentState = 'idle' | 'walking' | 'turning' | 'sitting_down' | 'seated' | 'standing_up' | 'lying_down' | 'lying' | 'getting_up';

type Step =
  | { kind: 'walk'; goal: Vec2 }
  | { kind: 'turn'; headingDeg: number }
  | { kind: 'sit'; seat: SeatPose }
  | { kind: 'stand' }
  | { kind: 'lie' }
  | { kind: 'unlie' }
  | { kind: 'wait'; seconds: number };

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
  /** 坐 ↔ 躺 的过渡时长 */
  lieDuration: number;
  log: LogFn;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  speed: 0.75,
  turnRateDeg: 300,
  turnInPlaceDeg: 50,
  sitDuration: 1.2,
  standDuration: 1.0,
  lieDuration: 1.3,
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
  /** 躺平权重 0～1 */
  private lieAmt = 0;
  private lieT = 0;
  private waitLeft = 0;
  /** 闲逛途中的停顿（站着四处看看） */
  private waiting = false;
  /** 上一条走位指令是否因寻路无解而放弃 */
  failed = false;
  /** 活动动作层：当前动作名与权重；wantAnim 是想要换成的动作 */
  private anim: string | null = null;
  private wantAnim: string | null = null;
  private animAmt = 0;
  private animTime = 0;
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

  /** 坐 / 躺的权重 0～1（接触阴影等用） */
  get sitWeight() {
    return Math.max(this.seatAmt, this.lieAmt);
  }

  get lieWeight() {
    return this.lieAmt;
  }

  /** 已经站定 / 坐定 / 躺定，手上没有未完成的走位 */
  get settled() {
    return (this.state === 'idle' || this.state === 'seated' || this.state === 'lying') && this.queue.length === 0 && !this.pending && !this.waiting;
  }

  /** 指定到位后的活动动作（null = 只保留基础姿势）。站定 / 坐定 / 躺定时才会渐入。 */
  setAnim(name: string | null) {
    this.wantAnim = name;
  }

  get animName() {
    return this.anim;
  }

  get animWeight() {
    return this.animAmt;
  }

  /** 当前（或正在坐下 / 起身的）座面高度，米 */
  get seatHeight() {
    return (this.tween.seat ?? this.seat)?.height ?? 0;
  }

  get busy() {
    return this.state !== 'idle' && this.state !== 'seated' && this.state !== 'lying';
  }

  /** 走到某点（站着） */
  walkTo(goal: Vec2) {
    this.command([{ kind: 'walk', goal }]);
  }

  /** 走到座位前、转身、坐下 */
  sitAt(seat: SeatPose) {
    if (this.state === 'seated' && this.seat?.id === seat.id) return;
    if (this.state === 'lying' && this.seat?.id === seat.id) {
      this.queue = [{ kind: 'unlie' }];
      this.startNext();
      return;
    }
    this.command([
      { kind: 'walk', goal: seat.approach },
      { kind: 'turn', headingDeg: seat.headingDeg },
      { kind: 'sit', seat },
    ]);
  }

  /** 走到床边、转身、坐上去、躺平 */
  lieAt(seat: SeatPose) {
    if (this.state === 'lying' && this.seat?.id === seat.id) return;
    if (this.state === 'seated' && this.seat?.id === seat.id) {
      this.queue = [{ kind: 'lie' }];
      this.startNext();
      return;
    }
    this.command([
      { kind: 'walk', goal: seat.approach },
      { kind: 'turn', headingDeg: seat.headingDeg },
      { kind: 'sit', seat },
      { kind: 'lie' },
    ]);
  }

  /** 依次走过几个点，每到一处停一会儿（闲逛用） */
  stroll(stops: { goal: Vec2; pause: number }[]) {
    this.command(stops.flatMap((s) => [{ kind: 'walk', goal: s.goal } as Step, { kind: 'wait', seconds: s.pause } as Step]));
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

  private get inTransition() {
    return this.state === 'sitting_down' || this.state === 'standing_up' || this.state === 'lying_down' || this.state === 'getting_up';
  }

  /** 从当前姿势回到站姿需要先做的步骤 */
  private leaveSteps(): Step[] {
    if (this.state === 'lying') return [{ kind: 'unlie' }, { kind: 'stand' }];
    if (this.state === 'seated') return [{ kind: 'stand' }];
    return [];
  }

  private command(steps: Step[]) {
    this.failed = false;
    this.waiting = false;
    if (this.inTransition) {
      this.pending = steps;
      this.opts.log('info', '过渡中，新指令排队', { state: this.state });
      return;
    }
    this.queue = [...this.leaveSteps(), ...steps];
    this.startNext();
  }

  private startNext(): void {
    this.waiting = false;
    const step = this.queue.shift();
    if (!step) {
      this.state = this.seat ? (this.lieAmt > 0.5 ? 'lying' : 'seated') : 'idle';
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
          this.failed = true;
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
      case 'lie':
        if (!this.seat) {
          this.startNext();
          return;
        }
        this.lieT = 0;
        this.state = 'lying_down';
        return;
      case 'unlie':
        this.lieT = 0;
        this.state = 'getting_up';
        return;
      case 'wait':
        this.waitLeft = step.seconds;
        this.waiting = true;
        this.state = 'idle';
        this.path = [];
        return;
    }
  }

  /** 过渡结束：有排队指令就接着执行，否则继续原队列 */
  private finishTransition() {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.queue = [...this.leaveSteps(), ...p];
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
      case 'lying_down':
      case 'getting_up': {
        this.lieT = Math.min(this.opts.lieDuration, this.lieT + dt);
        const k = ease(this.lieT / this.opts.lieDuration);
        this.lieAmt = this.state === 'lying_down' ? k : 1 - k;
        if (this.lieT >= this.opts.lieDuration) {
          this.opts.log('info', this.state === 'lying_down' ? '躺下' : '坐起', { seat: this.seat?.id });
          this.state = this.state === 'lying_down' ? 'lying' : 'seated';
          this.finishTransition();
        }
        break;
      }
      case 'idle':
        // 闲逛途中的停顿
        if (this.waiting) {
          this.waitLeft -= dt;
          if (this.waitLeft <= 0) this.startNext();
        }
        break;
    }
    this.updateAnimLayer(dt);
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

  /** 活动动作层的渐入渐出：只有站定 / 坐定 / 躺定、且没有待办走位时才渐入；换动作先渐出再渐入 */
  private updateAnimLayer(dt: number) {
    const still = this.settled || this.waiting;
    const canShow = still && this.wantAnim !== null && this.wantAnim === this.anim;
    if (canShow) {
      this.animAmt = Math.min(1, this.animAmt + dt / 0.7);
    } else {
      this.animAmt = Math.max(0, this.animAmt - dt / 0.45);
      if (this.animAmt === 0 && still && this.anim !== this.wantAnim) {
        this.anim = this.wantAnim;
        this.animTime = 0;
      }
    }
    if (this.animAmt > 0) this.animTime += dt;
  }

  /** 眨眼：间隔 2.5～6 秒随机，偶尔连眨两下；半闭 → 闭 → 半闭 → 睁 */
  private updateBlink(dt: number) {
    // 睡着了：眼睛一直闭着
    if (this.anim === 'lie_sleep' && this.animAmt > 0.3) {
      if (this.eye !== 2) {
        this.eye = 2;
        this.rig.setEyes(2);
      }
      this.blinkWait = 0.6;
      return;
    }
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
    if (this.state === 'lying') this.lieAmt = 1;
    else if (this.state !== 'lying_down' && this.state !== 'getting_up') this.lieAmt = 0;

    const lie = this.lieAmt; // 躺平权重
    const k = this.seatAmt * (1 - lie); // 坐姿权重（躺平时腿伸直、上身放平）
    const w = this.walkAmt; // 走路权重
    const calm = (1 - w) * (1 - k); // 站立待机权重
    const t = this.time;
    const swing = Math.sin(this.phase);
    const breath = Math.sin(t * 2.3);
    const sway = Math.sin(t * 1.35); // 重心左右缓慢移动（约 4.6 秒一个来回）

    // 胯：高度、左右重心、走路上下起伏
    const seatH = (this.tween.seat ?? this.seat)?.height ?? REF_HIP_HEIGHT * r.scale;
    r.body.position.y = lerp(REF_HIP_HEIGHT, seatH / r.scale, this.seatAmt) + LIE_LIFT * lie + 0.012 * w * Math.abs(Math.cos(this.phase));
    r.body.position.x = 0.007 * calm * sway;
    r.body.rotation.z = 0.022 * calm * sway;
    // 躺平：整个身体绕胯向后放倒（脸朝上，头朝座位朝向的反方向）
    r.body.rotation.x = (-Math.PI / 2) * lie;

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
    r.torso.rotation.y = 0;
    r.torso.rotation.z = -0.03 * calm * sway;
    r.torso.scale.y = 1 + 0.013 * breath;
    r.torso.scale.z = 1;

    // 手臂：自然下垂略外张；走路前后摆；坐下时手放松搭在膝上（左右不对称）
    const roll = 0.22 + 0.012 * breath;
    const up = 1 - Math.max(k, lie); // 站着的程度：躺下时手臂贴着身体两侧
    r.armL.rotation.set(-0.38 * w * swing - 0.56 * k, 0, roll * up + 0.07 * k + 0.14 * lie);
    r.armR.rotation.set(0.38 * w * swing - 0.64 * k, 0, -roll * up - 0.05 * k - 0.14 * lie);
    r.foreL.rotation.z = 0;
    r.foreR.rotation.z = 0;
    r.foreL.rotation.x = -0.08 - 0.15 * w * Math.max(0, swing) - 0.5 * k;
    r.foreR.rotation.x = -0.08 - 0.15 * w * Math.max(0, -swing) - 0.36 * k;

    // 头：待机时偶尔左右看看；坐着微微歪头、略低头
    r.head.rotation.x = 0.05 * k + 0.012 * breath * (1 - w) * (1 - lie);
    r.head.rotation.y = 0.1 * (1 - w) * (1 - lie) * Math.sin(t * 0.35);
    r.head.rotation.z = 0.02 * calm * sway + 0.06 * k + 0.02 * (1 - w) * (1 - lie) * Math.sin(t * 0.9);

    if (this.anim && this.animAmt > 0) applyActivityPose(r, this.anim, this.animAmt, this.animTime);
  }
}

/** 躺平时胯部比床面高出多少（参考尺寸）：让后背贴着床面而不是陷进去 */
const LIE_LIFT = 0.06;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** 每 period 秒出现一次、持续 hold 秒的平滑脉冲（0→1→0），用来做「偶尔抬头」「偶尔抬手」 */
const pulse = (t: number, period: number, hold: number, offset = 0) => {
  const x = (((t + offset) % period) + period) % period;
  return smooth(0, 0.8, x) * (1 - smooth(hold, hold + 0.8, x));
};

/**
 * 活动动作层：在基础姿势（站 / 坐 / 躺）上叠加的动作，a 是权重 0～1，t 是这个动作已经演了多久。
 * 动作名来自 config/activities.json 的 anim；这里不认识的名字什么都不叠加（只保留基础姿势），
 * 所以新增活动不写动作也能演：走过去、站 / 坐 / 躺好。
 */
export function applyActivityPose(r: CharacterRig, anim: string, a: number, t: number) {
  const mix = (cur: number, target: number) => cur + (target - cur) * a;
  switch (anim) {
    case 'sit_type': {
      // 双手放键盘、轻微敲击；偶尔抬眼看屏幕
      const tap = Math.sin(t * 13) * 0.035;
      const glance = pulse(t, 9, 1.6, 3);
      r.torso.rotation.x = mix(r.torso.rotation.x, 0.16);
      r.armL.rotation.x = mix(r.armL.rotation.x, -0.78);
      r.armR.rotation.x = mix(r.armR.rotation.x, -0.78);
      r.armL.rotation.z = mix(r.armL.rotation.z, -0.1);
      r.armR.rotation.z = mix(r.armR.rotation.z, 0.1);
      r.foreL.rotation.x = mix(r.foreL.rotation.x, -0.95 + tap);
      r.foreR.rotation.x = mix(r.foreR.rotation.x, -0.95 - tap);
      r.head.rotation.x = mix(r.head.rotation.x, 0.14 - 0.2 * glance);
      r.head.rotation.y = mix(r.head.rotation.y, 0);
      break;
    }
    case 'sit_write': {
      // 低头写字：右手小幅来回；每隔一阵停笔抬头想一想
      const think = pulse(t, 11, 2.2, 5);
      const scribble = (1 - think) * Math.sin(t * 8.5) * 0.07;
      r.torso.rotation.x = mix(r.torso.rotation.x, 0.24 - 0.08 * think);
      r.head.rotation.x = mix(r.head.rotation.x, 0.3 - 0.32 * think);
      r.head.rotation.y = mix(r.head.rotation.y, 0.12 * think);
      r.head.rotation.z = mix(r.head.rotation.z, 0.05);
      r.armL.rotation.x = mix(r.armL.rotation.x, -0.7);
      r.armL.rotation.z = mix(r.armL.rotation.z, -0.18);
      r.foreL.rotation.x = mix(r.foreL.rotation.x, -1.0);
      r.armR.rotation.x = mix(r.armR.rotation.x, -0.82 + scribble * 0.3);
      r.armR.rotation.z = mix(r.armR.rotation.z, 0.12 + scribble);
      r.foreR.rotation.x = mix(r.foreR.rotation.x, -0.9);
      break;
    }
    case 'sit_watch': {
      // 看电视：靠坐，过一阵换个坐姿（上身左右挪一点），头跟着画面微动
      const shift = Math.sin(t * 0.21) * 0.06 + Math.sin(t * 0.083 + 1) * 0.04;
      r.torso.rotation.x = mix(r.torso.rotation.x, 0.02);
      r.torso.rotation.z = mix(r.torso.rotation.z, shift);
      r.head.rotation.x = mix(r.head.rotation.x, -0.04);
      r.head.rotation.y = mix(r.head.rotation.y, 0.05 * Math.sin(t * 0.5));
      r.head.rotation.z = mix(r.head.rotation.z, -shift * 0.6);
      break;
    }
    case 'listen': {
      // 听歌：头跟着节拍轻晃，身体微微摇
      const beat = t * 3.4;
      r.head.rotation.z = mix(r.head.rotation.z, 0.1 * Math.sin(beat));
      r.head.rotation.x = mix(r.head.rotation.x, 0.03 + 0.035 * Math.sin(beat * 2));
      r.head.rotation.y = mix(r.head.rotation.y, 0.04 * Math.sin(beat * 0.5));
      r.torso.rotation.z = mix(r.torso.rotation.z, 0.025 * Math.sin(beat));
      break;
    }
    case 'lie_sleep': {
      // 睡觉：呼吸更深更慢；偶尔翻个身（侧一点再回来）
      const breath = Math.sin(t * 1.25);
      const turn = pulse(t, 31, 9, 20) - pulse(t, 47, 7, 5);
      r.torso.scale.z = 1 + 0.035 * a * breath;
      r.body.rotation.z = mix(r.body.rotation.z, 0.2 * turn);
      r.head.rotation.x = mix(r.head.rotation.x, 0.04);
      r.head.rotation.y = mix(r.head.rotation.y, 0.25 * turn);
      r.head.rotation.z = mix(r.head.rotation.z, 0);
      break;
    }
    case 'stand_gaze': {
      // 窗边发呆：微微仰头望出去；偶尔抬手贴一下玻璃
      const reach = pulse(t, 23, 4.5, 14);
      r.head.rotation.x = mix(r.head.rotation.x, -0.13);
      r.head.rotation.y = mix(r.head.rotation.y, 0.12 * Math.sin(t * 0.17));
      r.armR.rotation.x = mix(r.armR.rotation.x, -1.35 * reach);
      r.foreR.rotation.x = mix(r.foreR.rotation.x, -0.08 - 0.35 * reach);
      break;
    }
    case 'walk_look': {
      // 闲逛途中停下来左右看看
      r.head.rotation.y = mix(r.head.rotation.y, 0.5 * Math.sin(t * 0.9));
      r.head.rotation.x = mix(r.head.rotation.x, -0.04);
      break;
    }
    default:
      break;
  }
}
