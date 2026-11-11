import { describe, expect, it } from 'vitest';
import { anchorPose, computeWallLayout, footprint, houseBounds, wallPieces } from '../src/scene/layout';
import { validateAll } from '../src/config/validate';
import { readRawConfig } from './helpers';

describe('墙体生成', () => {
  const raw = readRawConfig();
  const layout = computeWallLayout(raw.rooms);

  it('一室一厅生成 7 段墙，其中客厅/卧室之间的公共墙只生成一次且为内墙', () => {
    expect(layout.segments).toHaveLength(7);
    const interior = layout.segments.filter((s) => s.interior);
    expect(interior).toHaveLength(1);
    expect(interior[0].edgeIds).toEqual(['bedroom_left', 'living_right']);
    expect(interior[0].outward).toBeNull();
  });

  it('外墙法线朝外', () => {
    const left = layout.segments.find((s) => s.id === 'living_left')!;
    expect(left.outward).toEqual([-1, 0]);
    const top = layout.segments.find((s) => s.id === 'living_top')!;
    expect(top.outward).toEqual([0, 1]);
  });

  it('门洞是真实开洞：门所在墙段被切成 3 块，门洞处只剩门楣', () => {
    const wall = layout.segments.find((s) => s.interior)!;
    const pieces = wallPieces(wall, layout.thickness);
    expect(pieces).toHaveLength(3);
    const lintel = pieces.find((p) => p.s === 2.7 && p.e === 3.7)!;
    expect(lintel).toMatchObject({ y0: 2.1, y1: 2.6 });
    // 门洞 2.7～3.7、0～2.1 米范围内没有任何实心块
    const blocking = pieces.filter((p) => p.s < 3.6 && p.e > 2.8 && p.y0 < 2.0);
    expect(blocking).toEqual([]);
  });

  it('落地窗：窗台 0.1 米以下与窗顶 2.3 米以上是墙，中间是洞', () => {
    const wall = layout.segments.find((s) => s.id === 'living_top')!;
    const pieces = wallPieces(wall, layout.thickness).filter((p) => p.s === 2 && p.e === 4.4);
    expect(pieces).toEqual([
      { s: 2, e: 4.4, y0: 0, y1: 0.1 },
      { s: 2, e: 4.4, y0: 2.3, y1: 2.6 },
    ]);
  });

  it('在 rooms.json 加一个房间：多出房间与墙段，公共墙自动变内墙', () => {
    const r = readRawConfig();
    r.rooms.rooms.push({ id: 'study', name: '书房', bounds: [[9.5, 0], [12, 3]], floor: 'carpet', walls: [], doors: [] });
    expect(validateAll(r)).toEqual([]);
    const l2 = computeWallLayout(r.rooms);
    // 卧室右墙 0～3 米段与书房左墙重合 → 内墙；3～4.5 米仍是外墙
    const shared = l2.segments.find((s) => s.edgeIds.includes('study_left'))!;
    expect(shared.interior).toBe(true);
    expect([shared.a, shared.b]).toEqual([0, 3]);
    const rest = l2.segments.find((s) => s.orient === 'v' && s.c === 9.5 && s.a === 3)!;
    expect(rest.interior).toBe(false);
    expect(houseBounds(r.rooms)).toEqual({ x0: 0, y0: 0, x1: 12, y1: 4.5 });
  });
});

describe('家具局部坐标', () => {
  const raw = readRawConfig();
  const item = (id: string) => raw.furniture.items.find((i: { id: string }) => i.id === id);

  it('沙发坐点在沙发正前方，人面朝 +x（电视方向）', () => {
    const sofa = item('sofa');
    const pose = anchorPose(sofa, sofa.anchors[0]);
    expect(pose.plan[0]).toBeCloseTo(0.63);
    expect(pose.plan[1]).toBeCloseTo(2.2);
    expect(pose.headingDeg).toBeCloseTo(0);
  });

  it('电脑桌坐点落在椅子位置，人面朝桌子（+x）', () => {
    const desk = item('desk');
    const pose = anchorPose(desk, desk.anchors[0]);
    expect(pose.plan[0]).toBeCloseTo(item('office_chair').position[0]);
    expect(pose.plan[1]).toBeCloseTo(item('office_chair').position[1]);
    expect(pose.headingDeg).toBeCloseTo(0);
  });

  it('改沙发 position 后，占地与坐点跟着走', () => {
    const sofa = { ...item('sofa'), position: [3, 3.5] };
    const pose = anchorPose(sofa, sofa.anchors[0]);
    expect(pose.plan[0]).toBeCloseTo(3.08);
    expect(pose.plan[1]).toBeCloseTo(3.5);
    const xs = footprint(sofa).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(2.55);
    expect(Math.max(...xs)).toBeCloseTo(3.45);
  });
});
