import { describe, expect, it } from 'vitest';
import { anchorPose, computeWallLayout, footprint, houseBounds, wallPieces } from '../src/scene/layout';
import { validateAll } from '../src/config/validate';
import { readRawConfig } from './helpers';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('墙体生成', () => {
  const raw = readRawConfig();
  const layout = computeWallLayout(raw.rooms);

  it('五个室内区域 + 阳台：生成 14 段墙，房间之间的公共墙只生成一次且为内墙', () => {
    expect(layout.segments).toHaveLength(14);
    const interior = layout.segments.filter((s) => s.interior);
    expect(interior.map((s) => s.id).sort()).toEqual([
      'bathroom_bottom+foyer_top',
      'bathroom_right+bedroom_left',
      'bedroom_bottom+living_top',
      'bedroom_right+study_left',
      'living_top+study_bottom',
    ]);
    expect(interior.every((s) => s.outward === null)).toBe(true);
  });

  it('玄关与客厅之间是开放边界：这一面不砌墙', () => {
    const between = layout.segments.filter((s) => s.orient === 'v' && near(s.c, 2.2) && s.a < 4.2 - 1e-6);
    expect(between).toEqual([]);
  });

  it('阳台是室外区域：自己不生成墙、没有围栏；与室内之间的墙算外墙', () => {
    expect(layout.segments.filter((s) => s.edgeIds.some((id) => id.startsWith('balcony_')))).toEqual([]);
    expect(layout.segments.filter((s) => s.orient === 'v' && near(s.c, 10.6))).toEqual([]);
    const livingRight = layout.segments.find((s) => s.id === 'living_right')!;
    expect(livingRight.interior).toBe(false);
    expect(livingRight.outward).toEqual([1, 0]);
  });

  it('外墙法线朝外', () => {
    expect(layout.segments.find((s) => s.id === 'foyer_left')!.outward).toEqual([-1, 0]);
    expect(layout.segments.find((s) => s.id === 'bedroom_top')!.outward).toEqual([0, 1]);
    expect(layout.segments.find((s) => s.id === 'living_bottom')!.outward).toEqual([0, -1]);
  });

  it('门洞是真实开洞：卧室门所在墙段被切成 3 块，门洞处只剩门楣', () => {
    const wall = layout.segments.find((s) => s.id === 'bedroom_bottom+living_top')!;
    const pieces = wallPieces(wall, layout.thickness);
    expect(pieces).toHaveLength(3);
    const lintel = pieces.find((p) => near(p.s, 2.5) && near(p.e, 3.4))!;
    expect(lintel).toMatchObject({ y0: 2.1, y1: 2.6 });
    // 门洞 2.5～3.4、0～2.1 米范围内没有任何实心块
    const blocking = pieces.filter((p) => p.s < 3.3 && p.e > 2.6 && p.y0 < 2.0);
    expect(blocking).toEqual([]);
  });

  it('客厅通阳台：大玻璃（落地）旁边留 1 米通道，两者上方才是墙', () => {
    const wall = layout.segments.find((s) => s.id === 'living_right')!;
    const pieces = wallPieces(wall, layout.thickness);
    const glass = pieces.filter((p) => near(p.s, 0.6) && near(p.e, 2.6));
    expect(glass.map((p) => [p.y0, p.y1])).toEqual([
      [0, 0.05],
      [2.3, 2.6],
    ]);
    const passage = pieces.filter((p) => near(p.s, 2.6) && near(p.e, 3.6));
    expect(passage.map((p) => [p.y0, p.y1])).toEqual([[2.3, 2.6]]);
  });

  it('书房与阳台之间是落地大窗，没有门', () => {
    const wall = layout.segments.find((s) => s.id === 'study_right')!;
    expect(wall.openings.map((o) => o.kind)).toEqual(['window']);
    const win = wall.openings[0];
    expect([win.s, win.e, win.bottom, win.top].map((v) => +v.toFixed(3))).toEqual([4.8, 7.2, 0.05, 2.3]);
  });

  it('在 rooms.json 加一个房间：多出房间与墙段，公共墙自动变内墙', () => {
    const r = readRawConfig();
    r.rooms.rooms.push({ id: 'kitchen', name: '厨房', bounds: [[2.2, -3], [5, 0]], floor: 'tile', walls: [], doors: [] });
    expect(validateAll(r)).toEqual([]);
    const l2 = computeWallLayout(r.rooms);
    // 客厅下墙 2.2～5 米段与厨房上墙重合 → 内墙；5～8.8 米仍是外墙
    const shared = l2.segments.find((s) => s.edgeIds.includes('kitchen_top'))!;
    expect(shared.interior).toBe(true);
    expect([shared.a, shared.b]).toEqual([2.2, 5]);
    const rest = l2.segments.find((s) => s.orient === 'h' && s.c === 0 && s.a === 5)!;
    expect(rest.interior).toBe(false);
    expect(houseBounds(r.rooms)).toEqual({ x0: 0, y0: -3, x1: 10.6, y1: 7.8 });
  });
});

describe('家具局部坐标', () => {
  const raw = readRawConfig();
  const item = (id: string) => raw.furniture.items.find((i: { id: string }) => i.id === id);

  it('沙发靠下墙朝上：坐点在座垫前半（小腿能垂下），人面朝 +y（电视方向）', () => {
    const sofa = item('sofa');
    const pose = anchorPose(sofa, sofa.anchors[0]);
    expect(pose.plan[0]).toBeCloseTo(5.2);
    expect(pose.plan[1]).toBeCloseTo(0.86);
    expect(pose.headingDeg).toBeCloseTo(90);
    // 电视在沙发正前方、靠上墙
    const tv = item('tv_stand');
    expect(tv.position[0]).toBeCloseTo(sofa.position[0]);
    expect(tv.position[1]).toBeGreaterThan(3.8);
  });

  it('书房电脑桌靠上墙：坐点在椅面前半（椅子中心往桌子方向 0.12 米），人面朝桌子（+y）', () => {
    const desk = item('desk');
    expect(desk.room).toBe('study');
    const pose = anchorPose(desk, desk.anchors[0]);
    expect(pose.plan[0]).toBeCloseTo(item('office_chair').position[0]);
    expect(pose.plan[1]).toBeCloseTo(item('office_chair').position[1] + 0.12);
    expect(pose.headingDeg).toBeCloseTo(90);
  });

  it('改沙发 position 后，占地与坐点跟着走', () => {
    const sofa = { ...item('sofa'), position: [3, 3.5] };
    const pose = anchorPose(sofa, sofa.anchors[0]);
    expect(pose.plan[0]).toBeCloseTo(3);
    expect(pose.plan[1]).toBeCloseTo(3.84);
    const xs = footprint(sofa).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(1.95);
    expect(Math.max(...xs)).toBeCloseTo(4.05);
  });
});
