// 浏览器端加载配置：JSON 随打包一起走（离线可用），加载后再校验一次。

import rooms from '../../config/rooms.json';
import furniture from '../../config/furniture.json';
import activities from '../../config/activities.json';
import characters from '../../config/characters.json';
import camera from '../../config/camera.json';
import type { AppConfig } from './types';
import { parseConfig } from './validate';

export function loadConfig(): AppConfig {
  // structuredClone：后续拖家具会改内存里的配置，避免改到模块缓存
  return parseConfig(structuredClone({ rooms, furniture, activities, characters, camera }));
}
