// 把 furniture.json 里的交互点换算成全屋坐标下的「座位」与「站位」。纯函数。

import type { SeatPose } from '../character/agent';
import type { FurnitureItem, Vec2 } from '../config/types';
import { anchorPose, localToPlan } from './layout';

export interface StandSpot {
  id: string;
  plan: Vec2;
  headingDeg: number;
}

export interface AnchorIndex {
  /** 需要坐 / 躺的交互点（有高度），key = 家具id:交互点id */
  seats: Map<string, SeatPose>;
  /** 站着用的交互点（高度 0） */
  stands: Map<string, StandSpot>;
  /** 交互点类型 → 所有实例 key（如 window_stand → 两扇窗） */
  byType: Map<string, string[]>;
}

export function indexAnchors(items: FurnitureItem[]): AnchorIndex {
  const seats = new Map<string, SeatPose>();
  const stands = new Map<string, StandSpot>();
  const byType = new Map<string, string[]>();
  for (const it of items) {
    for (const a of it.anchors) {
      const key = `${it.id}:${a.id}`;
      const pose = anchorPose(it, a);
      const approach = a.approach ? localToPlan(it, a.approach) : pose.plan;
      if (pose.height > 0.05) {
        seats.set(key, { id: key, plan: pose.plan, height: pose.height, headingDeg: pose.headingDeg, approach });
      } else {
        stands.set(key, { id: key, plan: approach, headingDeg: pose.headingDeg });
      }
      if (!byType.has(a.id)) byType.set(a.id, []);
      byType.get(a.id)!.push(key);
    }
  }
  return { seats, stands, byType };
}
