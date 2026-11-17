// 美术方向「湖心微缩小屋」的色板与光照预设（docs/art/美术方向.md）。
// 所有颜色都在这里集中定义：改色调只改这一个文件。状态：proposed（等客户选定后改为 confirmed）。

export type TimeOfDay = 'day' | 'golden' | 'night';

export const PALETTE = {
  // 湖水：由浅到深，近岸偏青绿，远处偏蓝
  water: { shallow: '#a7dfd2', mid: '#6cb8bd', deep: '#3f86a0', foam: '#f6faf3' },
  // 地面：草地按「受光 / 中间 / 背光」三块大色面组织，不做逐根草的细节
  grass: { lit: '#bad785', mid: '#98c172', shade: '#77a565' },
  ground: { path: '#dcc39a', sand: '#efdfba', earth: '#b8916a', rock: '#b1aaa0', rockDark: '#8a847c' },
  // 植被：树冠同样是 3～4 个明度带；粉色花树是唯一的次要点缀，呼应笑笑的腮红
  foliage: { lit: '#b2cf7a', mid: '#86b067', shade: '#5f8b58', trunk: '#8b6a50', blossom: '#f6cdd2', blossomShade: '#e8b3bb', reed: '#a5b673' },
  flowers: ['#fbf6ec', '#f6dd8c', '#f3c3cb', '#cfe0f2'],
  // 房子外观：暖白灰泥墙 + 原木 + 石材墙基；陶土红屋顶是整个画面唯一的高饱和暖色焦点
  exterior: { plaster: '#f4ece0', stone: '#beb5a8', timber: '#b48a62', timberDark: '#8f6a4a', roof: '#c7674c', roofDark: '#a8513c', trim: '#fbf6ee', door: '#7f9d8e' },
  // 室内：每个房间一种墙色，都在同一个暖色家族里，靠明度和冷暖区分
  rooms: {
    foyer: { wall: '#efe5d6', rug: '#d8c4a6', accent: '#b48a62' },
    living: { wall: '#f2e8d8', rug: '#e8d8c0', accent: '#d08d6b' },
    bathroom: { wall: '#dcebe7', rug: '#c9dfdb', accent: '#9cc3c0' },
    bedroom: { wall: '#f1ddd5', rug: '#efd2c8', accent: '#d9a2a0' },
    study: { wall: '#e0e8d6', rug: '#cfdcc4', accent: '#8fae86' },
    balcony: { wall: '#f2e8d8', rug: '#e8d8c0', accent: '#b48a62' },
  } as Record<string, { wall: string; rug: string; accent: string }>,
  baseboard: '#fbf6ee',
  /** 室内暖光（约 2700K）与月光 */
  lamp: '#ffb46b',
  moon: '#a9bde6',
};

export interface LightingPreset {
  /** 太阳 / 月亮的方位（平面角，度，0 = +x，逆时针）与高度角（度） */
  sunAzimuth: number;
  sunElevation: number;
  sunColor: string;
  sunIntensity: number;
  sunShadow: boolean;
  /** 天光：上方偏蓝、下方偏绿 / 偏暖，让阴影带颜色而不是发黑 */
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  envIntensity: number;
  exposure: number;
  sky: { zenith: string; horizon: string; below: string; glow: string };
  cloud: { lit: string; shade: string; opacity: number };
  /** 远山两层的颜色（近的深一些） */
  hills: [string, string];
  fog: { color: string; near: number; far: number };
  /** 室内灯、窗户、码头灯是否点亮 */
  practicals: boolean;
  /** 水面上太阳 / 月亮倒影的强度 */
  glint: number;
  /** 湖水本身颜色的整体乘数（夜里压暗、黄昏偏暖） */
  waterTint: string;
}

export const LIGHTING: Record<TimeOfDay, LightingPreset> = {
  // 白天：高而暖的太阳，蓝色天光补阴影；画面最亮处是云的受光面
  day: {
    sunAzimuth: 130,
    sunElevation: 52,
    sunColor: '#fff2d8',
    sunIntensity: 2.3,
    sunShadow: true,
    hemiSky: '#a9cdee',
    hemiGround: '#8c9a62',
    hemiIntensity: 0.85,
    envIntensity: 0.32,
    exposure: 1.0,
    sky: { zenith: '#6ea9dd', horizon: '#e6f1f2', below: '#d3e6ea', glow: '#fff6dc' },
    cloud: { lit: '#fefcf6', shade: '#d6e3ec', opacity: 0.95 },
    hills: ['#c3d6d3', '#a9c6b4'],
    fog: { color: '#dcebef', near: 70, far: 420 },
    practicals: false,
    glint: 1.0,
    waterTint: '#ffffff',
  },
  // 黄昏：低而橙的太阳配冷蓝天光，长影子描出地面起伏
  golden: {
    sunAzimuth: 205,
    sunElevation: 11,
    sunColor: '#ffb46b',
    sunIntensity: 2.6,
    sunShadow: true,
    hemiSky: '#8fa3d8',
    hemiGround: '#6e5a48',
    hemiIntensity: 0.7,
    envIntensity: 0.22,
    exposure: 0.98,
    sky: { zenith: '#6077b5', horizon: '#f7c591', below: '#e9b88f', glow: '#ffd29a' },
    cloud: { lit: '#ffd9b0', shade: '#a58fb7', opacity: 0.95 },
    hills: ['#b8a2b4', '#9b8ea6'],
    fog: { color: '#f1c49c', near: 60, far: 380 },
    practicals: true,
    glint: 1.4,
    waterTint: '#e9d6c8',
  },
  // 夜晚：画面靠一团团暖光组织，月光只负责勾出屋顶和树的轮廓；最暗处是有颜色的深蓝，不是纯黑
  night: {
    sunAzimuth: 60,
    sunElevation: 42,
    sunColor: '#a9bde6',
    sunIntensity: 0.32,
    sunShadow: false,
    hemiSky: '#2c3d6e',
    hemiGround: '#141a26',
    hemiIntensity: 0.55,
    envIntensity: 0.06,
    exposure: 1.18,
    sky: { zenith: '#0d1630', horizon: '#33476f', below: '#1f2b47', glow: '#c9d6f2' },
    cloud: { lit: '#5d6b8e', shade: '#2a3452', opacity: 0.7 },
    hills: ['#2b3754', '#222c45'],
    fog: { color: '#2a3a5e', near: 50, far: 340 },
    practicals: true,
    // 月亮倒影暂不画：法线扰动会把它散成一大团，移轴后像水上飘着一朵云。以后做成一条竖向的光带
    glint: 0,
    waterTint: '#2c3d63',
  },
};
