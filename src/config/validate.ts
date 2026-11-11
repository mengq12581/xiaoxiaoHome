// 配置校验：启动时（Vite 插件）与浏览器加载时各跑一遍。
// 规则：发现问题直接报错并指出「文件 + 字段路径」，不静默用默认值兜底。

import {
  CONFIG_FILES,
  FLOOR_KINDS,
  FURNITURE_KINDS,
  type AppConfig,
  type ConfigKey,
  type RoomsConfig,
  type Vec2,
} from './types';
import { EPS, acrossOf, alongOf, allEdges, collectOpenings, footprint, normBounds, windowRange } from '../scene/layout';

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

type Raw = Record<ConfigKey, unknown>;

class Collector {
  issues: ConfigIssue[] = [];
  constructor(private file: string) {}
  err(path: string, message: string) {
    this.issues.push({ file: this.file, path, message });
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isVec = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(isNum);
const HEX = /^#[0-9a-fA-F]{6}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function need(c: Collector, obj: Record<string, unknown>, path: string, key: string, check: (v: unknown) => boolean, what: string): boolean {
  if (!(key in obj)) {
    c.err(`${path}.${key}`, `缺少必填字段（应为${what}）`);
    return false;
  }
  if (!check(obj[key])) {
    c.err(`${path}.${key}`, `应为${what}，实际是 ${JSON.stringify(obj[key])}`);
    return false;
  }
  return true;
}

function opt(c: Collector, obj: Record<string, unknown>, path: string, key: string, check: (v: unknown) => boolean, what: string): boolean {
  if (!(key in obj) || obj[key] === undefined) return true;
  if (!check(obj[key])) {
    c.err(`${path}.${key}`, `应为${what}，实际是 ${JSON.stringify(obj[key])}`);
    return false;
  }
  return true;
}

// ───────── rooms.json ─────────

function validateRooms(raw: unknown): { issues: ConfigIssue[]; ok: boolean } {
  const c = new Collector(CONFIG_FILES.rooms);
  if (!isObj(raw)) {
    c.err('$', '顶层应为对象');
    return { issues: c.issues, ok: false };
  }
  if (need(c, raw, '$', 'grid', isObj, '对象')) {
    const g = raw.grid as Record<string, unknown>;
    need(c, g, '$.grid', 'size', (v) => isNum(v) && v > 0, '正数');
    need(c, g, '$.grid', 'unit', (v) => v === 'm', '"m"');
  }
  opt(c, raw, '$', 'wall_height', (v) => isNum(v) && v >= 1.8 && v <= 5, '1.8～5 之间的数');
  opt(c, raw, '$', 'wall_thickness', (v) => isNum(v) && v >= 0.04 && v <= 0.5, '0.04～0.5 之间的数');

  let structural = true;
  if (!need(c, raw, '$', 'rooms', (v) => Array.isArray(v) && v.length > 0, '非空数组')) structural = false;
  const rooms = (Array.isArray(raw.rooms) ? raw.rooms : []) as unknown[];
  const ids = new Set<string>();
  rooms.forEach((r, i) => {
    const p = `$.rooms[${i}]`;
    if (!isObj(r)) {
      c.err(p, '应为对象');
      structural = false;
      return;
    }
    if (need(c, r, p, 'id', isStr, '非空字符串')) {
      if (ids.has(r.id as string)) c.err(`${p}.id`, `房间 id 重复：${r.id}`);
      ids.add(r.id as string);
    } else structural = false;
    need(c, r, p, 'name', isStr, '非空字符串');
    const okB = need(
      c,
      r,
      p,
      'bounds',
      (v) => Array.isArray(v) && v.length === 2 && isVec(v[0], 2) && isVec(v[1], 2),
      '[[x0,y0],[x1,y1]]',
    );
    if (okB) {
      const [[ax, ay], [bx, by]] = r.bounds as [Vec2, Vec2];
      if (Math.abs(ax - bx) < 1 || Math.abs(ay - by) < 1) c.err(`${p}.bounds`, '房间边长至少 1 米');
    } else structural = false;
    need(c, r, p, 'floor', (v) => (FLOOR_KINDS as readonly unknown[]).includes(v), `其中之一：${FLOOR_KINDS.join(' / ')}`);
    if (!need(c, r, p, 'walls', Array.isArray, '数组（可为空）')) structural = false;
    if (!need(c, r, p, 'doors', Array.isArray, '数组（可为空）')) structural = false;
    if (Array.isArray(r.walls)) {
      (r.walls as unknown[]).forEach((w, j) => {
        const wp = `${p}.walls[${j}]`;
        if (!isObj(w)) {
          c.err(wp, '应为对象');
          structural = false;
          return;
        }
        if (!need(c, w, wp, 'id', isStr, '非空字符串')) structural = false;
        opt(c, w, wp, 'from', (v) => isVec(v, 2), '[x,y]');
        opt(c, w, wp, 'to', (v) => isVec(v, 2), '[x,y]');
        opt(c, w, wp, 'height', (v) => isNum(v) && v >= 1.8 && v <= 5, '1.8～5 之间的数');
        if (opt(c, w, wp, 'windows', Array.isArray, '数组')) {
          ((w.windows as unknown[]) ?? []).forEach((win, k) => {
            const kp = `${wp}.windows[${k}]`;
            if (isVec(win, 2)) return;
            if (!isObj(win)) {
              c.err(kp, '应为 [起,止] 或 {id, span, sill, top}');
              structural = false;
              return;
            }
            if (!need(c, win, kp, 'span', (v) => isVec(v, 2), '[起,止]')) structural = false;
            opt(c, win, kp, 'id', isStr, '非空字符串');
            opt(c, win, kp, 'sill', (v) => isNum(v) && v >= 0, '非负数');
            opt(c, win, kp, 'top', (v) => isNum(v) && v > 0, '正数');
          });
        }
      });
    }
    if (Array.isArray(r.doors)) {
      (r.doors as unknown[]).forEach((d, j) => {
        const dp = `${p}.doors[${j}]`;
        if (!isObj(d)) {
          c.err(dp, '应为对象');
          structural = false;
          return;
        }
        if (!need(c, d, dp, 'id', isStr, '非空字符串')) structural = false;
        if (!need(c, d, dp, 'wall', isStr, '墙 id（如 living_right）')) structural = false;
        if (!need(c, d, dp, 'at', (v) => isVec(v, 2), '[x,y]')) structural = false;
        if (!need(c, d, dp, 'width', (v) => isNum(v) && v >= 0.6 && v <= 3, '0.6～3 之间的数')) structural = false;
        opt(c, d, dp, 'height', (v) => isNum(v) && v >= 1.8, '≥ 1.8 的数');
      });
    }
  });

  if (need(c, raw, '$', 'nav', isObj, '对象')) {
    const nav = raw.nav as Record<string, unknown>;
    need(c, nav, '$.nav', 'nodes', (v) => Array.isArray(v) && v.every((n) => isVec(n, 2)), '[[x,y], ...]');
    need(c, nav, '$.nav', 'edges', (v) => Array.isArray(v) && v.every((n) => isVec(n, 2)), '[[i,j], ...]');
  } else structural = false;

  if (!structural || c.issues.length) return { issues: c.issues, ok: false };

  // ── 语义检查 ──
  const cfg = raw as unknown as RoomsConfig;
  const roomsT = cfg.rooms;

  // 房间不能重叠
  for (let i = 0; i < roomsT.length; i++) {
    for (let j = i + 1; j < roomsT.length; j++) {
      const a = normBounds(roomsT[i]);
      const b = normBounds(roomsT[j]);
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > EPS && oy > EPS) c.err(`$.rooms[${j}].bounds`, `与房间 ${roomsT[i].id} 重叠`);
    }
  }

  const edges = allEdges(cfg);
  roomsT.forEach((room, i) => {
    const p = `$.rooms[${i}]`;
    const ownEdges = edges.filter((e) => e.roomId === room.id);
    room.walls.forEach((w, j) => {
      const wp = `${p}.walls[${j}]`;
      const edge = ownEdges.find((e) => e.id === w.id);
      if (!edge) {
        c.err(`${wp}.id`, `未知墙 id「${w.id}」，可用：${ownEdges.map((e) => e.id).join(' / ')}`);
        return;
      }
      for (const key of ['from', 'to'] as const) {
        const pt = w[key];
        if (!pt) continue;
        const on = Math.abs(acrossOf(edge.orient, pt) - edge.c) < 0.01;
        const al = alongOf(edge.orient, pt);
        if (!on || al < edge.a - 0.01 || al > edge.b + 0.01) c.err(`${wp}.${key}`, `点 ${JSON.stringify(pt)} 不在墙 ${edge.id} 上`);
      }
      const len = edge.b - edge.a;
      (w.windows ?? []).forEach((win, k) => {
        const kp = `${wp}.windows[${k}]`;
        const span = Array.isArray(win) ? win : win.span;
        if (span[0] < 0 || span[1] > len + EPS || span[1] - span[0] < 0.3) c.err(kp, `窗宽须 ≥ 0.3 且落在墙长 0～${len} 米内`);
        const r = windowRange(edge, w.from ?? edge.from, w.to ?? edge.to, win);
        if (r.sill >= r.top) c.err(kp, '窗台高度须小于窗顶高度');
        if (r.top > edge.height - 0.1) c.err(kp, `窗顶须低于墙高 ${edge.height} 至少 0.1 米`);
      });
    });
    room.doors.forEach((d, j) => {
      const dp = `${p}.doors[${j}]`;
      const edge = edges.find((e) => e.id === d.wall);
      if (!edge) {
        c.err(`${dp}.wall`, `未知墙 id「${d.wall}」，可用：${edges.map((e) => e.id).join(' / ')}`);
        return;
      }
      if (Math.abs(acrossOf(edge.orient, d.at) - edge.c) > 0.01) c.err(`${dp}.at`, `门洞中心不在墙 ${edge.id} 的墙线上`);
      const mid = alongOf(edge.orient, d.at);
      if (mid - d.width / 2 < edge.a + 0.1 || mid + d.width / 2 > edge.b - 0.1) c.err(`${dp}.at`, `门洞超出墙 ${edge.id} 的范围（两端至少留 0.1 米）`);
      if ((d.height ?? 2.1) > edge.height - 0.1) c.err(`${dp}.height`, `门高须低于墙高 ${edge.height} 至少 0.1 米`);
    });
  });

  // 同一条墙线上的门窗不能互相重叠
  const ops = collectOpenings(cfg, edges);
  for (let i = 0; i < ops.length; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      const a = ops[i];
      const b = ops[j];
      if (a.orient === b.orient && Math.abs(a.c - b.c) < EPS && a.s < b.e - EPS && b.s < a.e - EPS) {
        c.err('$.rooms', `门窗洞「${a.id}」与「${b.id}」在同一面墙上重叠`);
      }
    }
  }

  // 导航点必须在某个房间内；边索引合法
  const inAnyRoom = (pt: Vec2) =>
    roomsT.some((r) => {
      const b = normBounds(r);
      return pt[0] > b.x0 - EPS && pt[0] < b.x1 + EPS && pt[1] > b.y0 - EPS && pt[1] < b.y1 + EPS;
    });
  cfg.nav.nodes.forEach((n, i) => {
    if (!inAnyRoom(n)) c.err(`$.nav.nodes[${i}]`, `导航点 ${JSON.stringify(n)} 不在任何房间内`);
  });
  cfg.nav.edges.forEach(([a, b], i) => {
    const n = cfg.nav.nodes.length;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) c.err(`$.nav.edges[${i}]`, `索引须在 0～${n - 1} 之间`);
    else if (a === b) c.err(`$.nav.edges[${i}]`, '不能连到自己');
  });

  return { issues: c.issues, ok: c.issues.length === 0 };
}

// ───────── furniture.json ─────────

function validateFurniture(raw: unknown, rooms: RoomsConfig | null): ConfigIssue[] {
  const c = new Collector(CONFIG_FILES.furniture);
  if (!isObj(raw)) {
    c.err('$', '顶层应为对象');
    return c.issues;
  }
  if (!need(c, raw, '$', 'items', Array.isArray, '数组')) return c.issues;
  const ids = new Set<string>();
  (raw.items as unknown[]).forEach((it, i) => {
    const p = `$.items[${i}]`;
    if (!isObj(it)) {
      c.err(p, '应为对象');
      return;
    }
    const before = c.issues.length;
    if (need(c, it, p, 'id', isStr, '非空字符串')) {
      if (ids.has(it.id as string)) c.err(`${p}.id`, `家具 id 重复：${it.id}`);
      ids.add(it.id as string);
    }
    need(c, it, p, 'kind', (v) => (FURNITURE_KINDS as readonly unknown[]).includes(v), `其中之一：${FURNITURE_KINDS.join(' / ')}`);
    need(c, it, p, 'room', isStr, '房间 id');
    need(c, it, p, 'position', (v) => isVec(v, 2), '[x,y]');
    need(c, it, p, 'rotation', isNum, '数字（度）');
    need(c, it, p, 'size', (v) => isVec(v, 3) && (v as number[]).every((n) => n > 0 && n <= 5), '[宽,深,高]，每项 0～5 米');
    need(c, it, p, 'draggable', (v) => typeof v === 'boolean', 'true / false');
    need(c, it, p, 'group', (v) => v === null || isStr(v), 'null 或字符串');
    if (need(c, it, p, 'anchors', Array.isArray, '数组（可为空）')) {
      const aids = new Set<string>();
      (it.anchors as unknown[]).forEach((a, j) => {
        const ap = `${p}.anchors[${j}]`;
        if (!isObj(a)) {
          c.err(ap, '应为对象');
          return;
        }
        if (need(c, a, ap, 'id', isStr, '交互点类型（如 sofa_seat）')) {
          if (aids.has(a.id as string)) c.err(`${ap}.id`, `同一件家具上交互点重复：${a.id}`);
          aids.add(a.id as string);
        }
        need(c, a, ap, 'local', (v) => isVec(v, 3), '[右,前,高]');
        need(c, a, ap, 'facing', (v) => v === 'forward' || v === 'toward', '"forward" 或 "toward"');
        opt(c, a, ap, 'activity', isStr, '活动 id');
      });
    }
    if (c.issues.length > before || !rooms) return;
    const room = rooms.rooms.find((r) => r.id === it.room);
    if (!room) {
      c.err(`${p}.room`, `未知房间「${it.room}」，可用：${rooms.rooms.map((r) => r.id).join(' / ')}`);
      return;
    }
    const b = normBounds(room);
    const pts = it.kind === 'window_spot' ? [it.position as Vec2] : footprint(it as never);
    const tol = 0.02;
    if (pts.some(([x, y]) => x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol)) {
      c.err(`${p}.position`, `家具占地超出房间 ${room.id} 的范围 ${JSON.stringify(room.bounds)}`);
    }
  });
  return c.issues;
}

// ───────── activities.json ─────────

function validateActivities(raw: unknown, anchorIds: Set<string> | null): ConfigIssue[] {
  const c = new Collector(CONFIG_FILES.activities);
  if (!isObj(raw)) {
    c.err('$', '顶层应为对象');
    return c.issues;
  }
  if (need(c, raw, '$', 'activities', (v) => isObj(v) && Object.keys(v).length > 0, '非空对象')) {
    for (const [name, a] of Object.entries(raw.activities as Record<string, unknown>)) {
      const p = `$.activities.${name}`;
      if (!/^[a-z][a-z0-9_]*$/.test(name)) c.err(p, '活动 id 只能用小写字母、数字、下划线');
      if (!isObj(a)) {
        c.err(p, '应为对象');
        continue;
      }
      need(c, a, p, 'anim', isStr, '非空字符串');
      if (need(c, a, p, 'anchor', (v) => v === null || isStr(v) || (Array.isArray(v) && v.length > 0 && v.every(isStr)), 'null、交互点类型或其数组')) {
        const list = a.anchor === null ? [] : Array.isArray(a.anchor) ? (a.anchor as string[]) : [a.anchor as string];
        if (anchorIds) for (const an of list) if (!anchorIds.has(an)) c.err(`${p}.anchor`, `furniture.json 里没有交互点「${an}」`);
        if (opt(c, a, p, 'prefer_anchor', isStr, '交互点类型') && a.prefer_anchor !== undefined && !list.includes(a.prefer_anchor as string)) {
          c.err(`${p}.prefer_anchor`, '必须是 anchor 列表中的一项');
        }
      }
      need(c, a, p, 'min_dwell', (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1800, '0～1800 的整数（秒）');
      need(c, a, p, 'weight', (v) => isNum(v) && v >= 0, '非负数');
      need(c, a, p, 'duration', (v) => isVec(v, 2) && (v as number[])[0] >= 0 && (v as number[])[0] <= (v as number[])[1], '[最短,最长]（秒）');
      need(c, a, p, 'face', isStr, '非空字符串');
      opt(c, a, p, 'props', (v) => Array.isArray(v) && v.every(isStr), '字符串数组');
    }
  }
  need(c, raw, '$', 'quiet_hours', (v) => Array.isArray(v) && v.length === 2 && v.every((t) => typeof t === 'string' && HHMM.test(t)), '["HH:MM","HH:MM"]');
  need(c, raw, '$', 'idle_after_sec', (v) => isNum(v) && v > 0, '正数（秒）');
  if (opt(c, raw, '$', 'idle_pool_override', isObj, '对象') && isObj(raw.idle_pool_override) && isObj(raw.activities)) {
    for (const [mode, pool] of Object.entries(raw.idle_pool_override)) {
      if (!isObj(pool)) {
        c.err(`$.idle_pool_override.${mode}`, '应为 { 活动: 权重 }');
        continue;
      }
      for (const [act, w] of Object.entries(pool)) {
        if (!(act in raw.activities)) c.err(`$.idle_pool_override.${mode}.${act}`, '未知活动');
        if (!isNum(w) || w < 0) c.err(`$.idle_pool_override.${mode}.${act}`, '权重应为非负数');
      }
    }
  }
  return c.issues;
}

// ───────── characters.json ─────────

function validateCharacters(raw: unknown): ConfigIssue[] {
  const c = new Collector(CONFIG_FILES.characters);
  if (!isObj(raw)) {
    c.err('$', '顶层应为对象');
    return c.issues;
  }
  need(c, raw, '$', 'active', isStr, '角色 id');
  if (!need(c, raw, '$', 'characters', (v) => Array.isArray(v) && v.length > 0, '非空数组')) return c.issues;
  const ids = new Set<string>();
  (raw.characters as unknown[]).forEach((ch, i) => {
    const p = `$.characters[${i}]`;
    if (!isObj(ch)) {
      c.err(p, '应为对象');
      return;
    }
    if (need(c, ch, p, 'id', isStr, '非空字符串')) {
      if (ids.has(ch.id as string)) c.err(`${p}.id`, `角色 id 重复：${ch.id}`);
      ids.add(ch.id as string);
    }
    need(c, ch, p, 'name', isStr, '非空字符串');
    need(c, ch, p, 'height', (v) => isNum(v) && v >= 0.6 && v <= 2.2, '0.6～2.2 之间的数（米）');
    need(c, ch, p, 'model', isStr, '形象依据路径');
    need(c, ch, p, 'model_type', (v) => v === 'procedural' || v === 'placeholder' || v === 'gltf', '"procedural" / "placeholder" / "gltf"');
    if (need(c, ch, p, 'palette', isObj, '对象')) {
      for (const [k, v] of Object.entries(ch.palette as Record<string, unknown>)) {
        if (typeof v !== 'string' || !HEX.test(v)) c.err(`${p}.palette.${k}`, `颜色应为 #RRGGBB，实际是 ${JSON.stringify(v)}`);
      }
    }
    need(c, ch, p, 'activities', (v) => v === 'all' || (Array.isArray(v) && v.every(isStr)), '"all" 或活动 id 数组');
  });
  if (isStr(raw.active) && !ids.has(raw.active)) c.err('$.active', `未知角色「${raw.active}」，可用：${[...ids].join(' / ')}`);
  return c.issues;
}

// ───────── camera.json ─────────

function validateCamera(raw: unknown): ConfigIssue[] {
  const c = new Collector(CONFIG_FILES.camera);
  if (!isObj(raw)) {
    c.err('$', '顶层应为对象');
    return c.issues;
  }
  need(c, raw, '$', 'target', (v) => isVec(v, 3), '[x, 高, y]');
  const deg = (lo: number, hi: number) => (v: unknown) => isNum(v) && v >= lo && v <= hi;
  need(c, raw, '$', 'minPolarDeg', deg(1, 89), '1～89 的角度');
  need(c, raw, '$', 'maxPolarDeg', deg(1, 89), '1～89 的角度');
  need(c, raw, '$', 'minDistance', (v) => isNum(v) && v > 0, '正数');
  need(c, raw, '$', 'maxDistance', (v) => isNum(v) && v > 0, '正数');
  need(c, raw, '$', 'startAzimuthDeg', deg(-360, 360), '-360～360 的角度');
  need(c, raw, '$', 'startPolarDeg', deg(1, 89), '1～89 的角度');
  need(c, raw, '$', 'startDistance', (v) => isNum(v) && v > 0, '正数');
  need(c, raw, '$', 'wallFadeOpacity', deg(0, 1), '0～1 之间的数');
  need(c, raw, '$', 'wallFadeWithOutline', (v) => typeof v === 'boolean', 'true / false');
  need(c, raw, '$', 'wallFadeTarget', (v) => v === 'character_or_room_center' || v === 'room_center', '"character_or_room_center" 或 "room_center"');
  if (c.issues.length) return c.issues;
  const r = raw as Record<string, number>;
  if (r.minPolarDeg >= r.maxPolarDeg) c.err('$.minPolarDeg', '须小于 maxPolarDeg');
  if (r.minDistance >= r.maxDistance) c.err('$.minDistance', '须小于 maxDistance');
  if (r.startPolarDeg < r.minPolarDeg || r.startPolarDeg > r.maxPolarDeg) c.err('$.startPolarDeg', '须在 minPolarDeg～maxPolarDeg 之间');
  if (r.startDistance < r.minDistance || r.startDistance > r.maxDistance) c.err('$.startDistance', '须在 minDistance～maxDistance 之间');
  return c.issues;
}

// ───────── 汇总 ─────────

export function validateAll(raw: Raw): ConfigIssue[] {
  const roomsRes = validateRooms(raw.rooms);
  const roomsCfg = roomsRes.ok ? (raw.rooms as RoomsConfig) : null;
  const furnIssues = validateFurniture(raw.furniture, roomsCfg);
  let anchorIds: Set<string> | null = null;
  if (furnIssues.length === 0 && isObj(raw.furniture)) {
    anchorIds = new Set(
      ((raw.furniture as { items: { anchors: { id: string }[] }[] }).items ?? []).flatMap((it) => it.anchors.map((a) => a.id)),
    );
  }
  return [
    ...roomsRes.issues,
    ...furnIssues,
    ...validateActivities(raw.activities, anchorIds),
    ...validateCharacters(raw.characters),
    ...validateCamera(raw.camera),
  ];
}

export function formatIssues(issues: ConfigIssue[]): string {
  return [`配置校验失败（${issues.length} 处）：`, ...issues.map((i) => `  - ${i.file}  ${i.path}：${i.message}`)].join('\n');
}

export class ConfigError extends Error {
  constructor(public issues: ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'ConfigError';
  }
}

/** 校验通过才返回带类型的配置，否则抛 ConfigError */
export function parseConfig(raw: Raw): AppConfig {
  const issues = validateAll(raw);
  if (issues.length) throw new ConfigError(issues);
  return raw as unknown as AppConfig;
}
