import { describe, expect, it } from 'vitest';
import { CharacterAgent, angleDiff, type AgentState, type SeatPose } from '../src/character/agent';
import { createBareRig } from '../src/character/rig';
import { Pathfinder, furnitureObstacles, wallObstacles } from '../src/nav/pathfinder';
import { anchorPose, localToPlan } from '../src/scene/layout';
import type { Vec2 } from '../src/config/types';
import { readRawConfig } from './helpers';

const raw = readRawConfig();
const pf = () =>
  new Pathfinder(raw.rooms.nav.nodes, raw.rooms.nav.edges, [...wallObstacles(raw.rooms), ...furnitureObstacles(raw.furniture.items)]);

function seatOf(itemId: string): SeatPose {
  const it = raw.furniture.items.find((i: { id: string }) => i.id === itemId);
  const a = it.anchors[0];
  const pose = anchorPose(it, a);
  return { id: `${it.id}:${a.id}`, plan: pose.plan, height: pose.height, headingDeg: pose.headingDeg, approach: localToPlan(it, a.approach) };
}

interface Trace {
  states: AgentState[];
  maxStep: number;
  maxTurn: number;
  logs: string[];
}

/** 按 60fps 推进，记录每帧位移与转角 */
function run(agent: CharacterAgent, seconds: number, onFrame?: (t: number) => void): Trace {
  const dt = 1 / 60;
  const tr: Trace = { states: [agent.state], maxStep: 0, maxTurn: 0, logs: [] };
  for (let t = 0; t < seconds; t += dt) {
    const p0: Vec2 = [...agent.position] as Vec2;
    const h0 = agent.headingDeg;
    agent.update(dt);
    onFrame?.(t);
    tr.maxStep = Math.max(tr.maxStep, Math.hypot(agent.position[0] - p0[0], agent.position[1] - p0[1]));
    tr.maxTurn = Math.max(tr.maxTurn, Math.abs(angleDiff(agent.headingDeg, h0)));
    if (tr.states[tr.states.length - 1] !== agent.state) tr.states.push(agent.state);
  }
  return tr;
}

describe('角色走位', () => {
  it('从客厅走到卧室床边：逐帧连续、每帧位移 ≤ 速度×dt、全程不进障碍、最终到达', () => {
    const p = pf();
    const agent = new CharacterAgent(createBareRig('t'), p, [2.65, 2.2]);
    const goal = seatOf('bed').approach;
    agent.walkTo(goal);
    let inside = 0;
    const tr = run(agent, 25, () => {
      if (!p.isFree(agent.position)) inside++;
    });
    expect(inside).toBe(0);
    expect(tr.maxStep).toBeLessThanOrEqual(0.75 / 60 + 1e-6);
    expect(tr.maxTurn).toBeLessThanOrEqual(300 / 60 + 1e-6);
    expect(agent.state).toBe('idle');
    expect(agent.position[0]).toBeCloseTo(goal[0], 5);
    expect(agent.position[1]).toBeCloseTo(goal[1], 5);
  });

  it('坐到电脑椅：走到椅后站位 → 转身 → 1.2 秒坐下，最终坐在交互点、面朝桌子', () => {
    const agent = new CharacterAgent(createBareRig('t'), pf(), [2.65, 2.2]);
    const seat = seatOf('desk');
    agent.sitAt(seat);
    const tr = run(agent, 20);
    expect(tr.states).toEqual(['walking', 'turning', 'sitting_down', 'seated']);
    expect(agent.position[0]).toBeCloseTo(seat.plan[0], 5);
    expect(agent.position[1]).toBeCloseTo(seat.plan[1], 5);
    expect(Math.abs(angleDiff(agent.headingDeg, seat.headingDeg))).toBeLessThan(1e-6);
    // 坐下过程按 1.2 秒缓动，单帧位移远小于瞬移
    expect(tr.maxStep).toBeLessThan(0.05);
  });

  it('坐着时下新指令：先起身回到站位，再走过去', () => {
    const agent = new CharacterAgent(createBareRig('t'), pf(), [2.65, 2.2]);
    agent.sitAt(seatOf('desk'));
    run(agent, 20);
    agent.sitAt(seatOf('sofa'));
    const tr = run(agent, 30);
    expect(tr.states).toEqual(['standing_up', 'walking', 'turning', 'sitting_down', 'seated']);
    expect(agent.seat?.id).toBe('sofa:sofa_seat');
  });

  it('坐下过程中来新指令：排队，坐好后再执行', () => {
    const agent = new CharacterAgent(createBareRig('t'), pf(), [2.65, 2.2]);
    agent.sitAt(seatOf('desk'));
    let issued = false;
    const tr = run(agent, 40, () => {
      if (!issued && agent.state === 'sitting_down') {
        agent.walkTo([4.2, 3.6]);
        issued = true;
        expect(agent.state).toBe('sitting_down');
      }
    });
    expect(issued).toBe(true);
    // 坐好的那一帧立刻接排队指令起身，所以帧末观察不到 seated
    expect(tr.states).toEqual(['walking', 'turning', 'sitting_down', 'standing_up', 'walking', 'idle']);
    expect(agent.position[0]).toBeCloseTo(4.2, 5);
  });

  it('站着待机不是呆的：会眨眼、重心左右轻摆、呼吸起伏', () => {
    const rig = createBareRig('t');
    const eyes: number[] = [];
    rig.setEyes = (s) => eyes.push(s);
    const agent = new CharacterAgent(rig, pf(), [2.65, 2.2]);
    const xs: number[] = [];
    const breath: number[] = [];
    run(agent, 12, () => {
      xs.push(rig.body.position.x);
      breath.push(rig.torso.scale.y);
    });
    expect(eyes.filter((e) => e === 2).length).toBeGreaterThanOrEqual(2); // 12 秒内至少眨两次
    expect(eyes[eyes.length - 1]).toBe(0); // 眨完会睁开
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.01);
    expect(Math.max(...breath) - Math.min(...breath)).toBeGreaterThan(0.02);
    expect(agent.position).toEqual([2.65, 2.2]); // 摆动只在身体上，不挪位置
  });

  it('坐姿松弛：上身前倾、膝盖并拢、两腿一前一后、手臂不对称', () => {
    const rig = createBareRig('t');
    const agent = new CharacterAgent(rig, pf(), [2.65, 2.2]);
    agent.sitAt(seatOf('sofa'));
    run(agent, 30);
    expect(agent.state).toBe('seated');
    expect(rig.torso.rotation.x).toBeGreaterThan(0.08);
    expect(rig.legL.rotation.y).toBeLessThan(0); // 左膝往里收
    expect(rig.legR.rotation.y).toBeGreaterThan(0); // 右膝往里收
    expect(Math.abs(rig.shinL.rotation.x - rig.shinR.rotation.x)).toBeGreaterThan(0.2);
    expect(Math.abs(rig.armL.rotation.x - rig.armR.rotation.x)).toBeGreaterThan(0.04);
  });

  it('寻路无解：原地不动，写一条警告', () => {
    const logs: string[] = [];
    const agent = new CharacterAgent(createBareRig('t'), pf(), [2.65, 2.2], -90, {
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    const wardrobe = raw.furniture.items.find((i: { id: string }) => i.id === 'wardrobe').position;
    agent.walkTo(wardrobe);
    run(agent, 2);
    expect(agent.position).toEqual([2.65, 2.2]);
    expect(agent.state).toBe('idle');
    expect(logs).toContain('warn:寻路失败，原地停下');
  });
});
