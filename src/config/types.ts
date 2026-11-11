// 配置文件的类型定义。字段含义见 docs/数据与接口约定.md 与 docs/验收问题.md（B1–B5、C3）。

/** 平面坐标 [x, y]，米；x 向右，y 向上（平面图「上墙」y 最大）。 */
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface WindowObject {
  id?: string;
  /** 距墙 `from` 端点的起止米数 */
  span: Vec2;
  /** 窗台高度（米），默认 0.9 */
  sill?: number;
  /** 窗顶高度（米），默认 2.1 */
  top?: number;
}
export type WindowSpec = Vec2 | WindowObject;

export interface WallSpec {
  /** 必须是自动生成的墙 id：`<房间id>_top|bottom|left|right` */
  id: string;
  from?: Vec2;
  to?: Vec2;
  height?: number;
  windows?: WindowSpec[];
}

export interface DoorSpec {
  id: string;
  wall: string;
  /** 门洞中心点（平面坐标） */
  at: Vec2;
  width: number;
  height?: number;
}

export interface RoomSpec {
  id: string;
  name: string;
  bounds: [Vec2, Vec2];
  floor: string;
  walls: WallSpec[];
  doors: DoorSpec[];
}

export interface RoomsConfig {
  grid: { size: number; unit: string };
  wall_height?: number;
  wall_thickness?: number;
  rooms: RoomSpec[];
  nav: { nodes: Vec2[]; edges: Vec2[] };
}

export type Facing = 'forward' | 'toward';

export interface AnchorSpec {
  /** 交互点类型，例如 sofa_seat；同一类型可出现在多件家具上 */
  id: string;
  /** [右, 前, 高]，家具局部坐标（米） */
  local: Vec3;
  facing: Facing;
  activity?: string;
}

export interface FurnitureItem {
  id: string;
  kind: string;
  room: string;
  /** 家具中心，全屋绝对平面坐标 */
  position: Vec2;
  /** 度，平面图逆时针为正；0° 时家具正面朝 +y */
  rotation: number;
  /** [宽, 深, 高] 米 */
  size: Vec3;
  draggable: boolean;
  anchors: AnchorSpec[];
  group: string | null;
}

export interface FurnitureConfig {
  items: FurnitureItem[];
}

export interface ActivitySpec {
  anim: string;
  anchor: string | string[] | null;
  prefer_anchor?: string;
  min_dwell: number;
  weight: number;
  duration: Vec2;
  face: string;
  props?: string[];
  note?: string;
}

export interface ActivitiesConfig {
  activities: Record<string, ActivitySpec>;
  quiet_hours: [string, string];
  idle_after_sec: number;
  idle_pool_override?: Record<string, Record<string, number>>;
}

export interface CharacterSpec {
  id: string;
  name: string;
  height: number;
  model: string;
  model_type: 'procedural' | 'placeholder' | 'gltf';
  palette: Record<string, string>;
  activities: 'all' | string[];
}

export interface CharactersConfig {
  active: string;
  characters: CharacterSpec[];
}

export interface CameraConfig {
  /** [平面 x, 高度, 平面 y] */
  target: Vec3;
  minPolarDeg: number;
  maxPolarDeg: number;
  minDistance: number;
  maxDistance: number;
  startAzimuthDeg: number;
  startPolarDeg: number;
  startDistance: number;
  wallFadeOpacity: number;
  wallFadeWithOutline: boolean;
  wallFadeTarget: 'character_or_room_center' | 'room_center';
}

export interface AppConfig {
  rooms: RoomsConfig;
  furniture: FurnitureConfig;
  activities: ActivitiesConfig;
  characters: CharactersConfig;
  camera: CameraConfig;
}

export const CONFIG_FILES = {
  rooms: 'config/rooms.json',
  furniture: 'config/furniture.json',
  activities: 'config/activities.json',
  characters: 'config/characters.json',
  camera: 'config/camera.json',
} as const;

export type ConfigKey = keyof typeof CONFIG_FILES;

export const FLOOR_KINDS = ['wood_light', 'wood_warm', 'tile', 'carpet'] as const;

export const FURNITURE_KINDS = [
  'sofa',
  'coffee_table',
  'tv_stand',
  'desk',
  'office_chair',
  'bookshelf',
  'bed',
  'nightstand',
  'wardrobe',
  'window_spot',
] as const;
