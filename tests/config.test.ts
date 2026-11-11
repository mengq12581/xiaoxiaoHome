import { describe, expect, it } from 'vitest';
import { validateAll, parseConfig, ConfigError } from '../src/config/validate';
import { readRawConfig } from './helpers';

const paths = (raw: ReturnType<typeof readRawConfig>) => validateAll(raw).map((i) => `${i.file} ${i.path}`);

describe('配置合法性', () => {
  it('仓库里的 config/*.json 全部通过校验', () => {
    expect(validateAll(readRawConfig())).toEqual([]);
  });

  it('parseConfig 遇到错误抛 ConfigError 并带上问题列表', () => {
    const raw = readRawConfig();
    raw.furniture.items[0].kind = 'spaceship';
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    try {
      parseConfig(raw);
    } catch (e) {
      expect((e as ConfigError).issues[0]).toMatchObject({ file: 'config/furniture.json', path: '$.items[0].kind' });
      expect((e as Error).message).toContain('config/furniture.json');
    }
  });

  it('缺少必填字段时指出文件与字段路径', () => {
    const raw = readRawConfig();
    delete raw.rooms.rooms[1].floor;
    expect(paths(raw)).toContain('config/rooms.json $.rooms[1].floor');
  });

  it('门挂在不存在的墙上会被拒绝', () => {
    const raw = readRawConfig();
    raw.rooms.rooms[0].doors[0].wall = 'living_nowhere';
    expect(paths(raw)).toContain('config/rooms.json $.rooms[0].doors[0].wall');
  });

  it('门洞中心不在墙线上会被拒绝', () => {
    const raw = readRawConfig();
    raw.rooms.rooms[0].doors[0].at = [5.5, 3.2];
    expect(paths(raw)).toContain('config/rooms.json $.rooms[0].doors[0].at');
  });

  it('窗超出墙长会被拒绝', () => {
    const raw = readRawConfig();
    raw.rooms.rooms[0].walls[0].windows[0].span = [4, 7];
    expect(paths(raw)).toContain('config/rooms.json $.rooms[0].walls[0].windows[0]');
  });

  it('房间重叠会被拒绝', () => {
    const raw = readRawConfig();
    raw.rooms.rooms.push({ id: 'oops', name: '重叠', bounds: [[5, 1], [8, 3]], floor: 'tile', walls: [], doors: [] });
    expect(paths(raw)).toContain('config/rooms.json $.rooms[2].bounds');
  });

  it('导航边索引越界会被拒绝', () => {
    const raw = readRawConfig();
    raw.rooms.nav.edges.push([0, 99]);
    expect(paths(raw).some((p) => p.startsWith('config/rooms.json $.nav.edges['))).toBe(true);
  });

  it('家具摆到房间外会被拒绝', () => {
    const raw = readRawConfig();
    raw.furniture.items[0].position = [-2, 2];
    expect(paths(raw)).toContain('config/furniture.json $.items[0].position');
  });

  it('家具引用不存在的房间会被拒绝', () => {
    const raw = readRawConfig();
    raw.furniture.items[0].room = 'kitchen';
    expect(paths(raw)).toContain('config/furniture.json $.items[0].room');
  });

  it('活动引用不存在的交互点会被拒绝', () => {
    const raw = readRawConfig();
    raw.activities.activities.watch_tv.anchor = 'hammock_seat';
    expect(paths(raw)).toContain('config/activities.json $.activities.watch_tv.anchor');
  });

  it('min_dwell 超出 0～1800 会被拒绝', () => {
    const raw = readRawConfig();
    raw.activities.activities.sleep.min_dwell = 4000;
    expect(paths(raw)).toContain('config/activities.json $.activities.sleep.min_dwell');
  });

  it('active 角色必须存在', () => {
    const raw = readRawConfig();
    raw.characters.active = 'nobody';
    expect(paths(raw)).toContain('config/characters.json $.active');
  });

  it('active 可以切到 shuaishuai（占位）', () => {
    const raw = readRawConfig();
    raw.characters.active = 'shuaishuai';
    expect(validateAll(raw)).toEqual([]);
  });

  it('相机参数：最小距离须小于最大距离', () => {
    const raw = readRawConfig();
    raw.camera.minDistance = 20;
    expect(paths(raw)).toContain('config/camera.json $.minDistance');
  });

  it('相机参数：极角上下限须在 1～89°', () => {
    const raw = readRawConfig();
    raw.camera.maxPolarDeg = 95;
    expect(paths(raw)).toContain('config/camera.json $.maxPolarDeg');
  });
});
