export const LOOKOUT_EVENT_IDS = Object.freeze({
  NORMAL_CROSSING: 'normal-crossing',
  TUNNEL_HAZARD: 'tunnel-hazard',
  RAIL_GLINT_BREAK: 'rail-glint-break',
  INTRUSION_CROSSING: 'intrusion-crossing',
});

export const LOOKOUT_TRAINING_CONFIG = Object.freeze({
  title: 'K2026次途中瞭望技巧综合考评',
  subtitle: '平稳起车与贯通试验20分 · 途中瞭望80分',
  // 课堂考核压缩站间运行距离：贯通试验完成后约 0.5 km 出现首个道口，
  // 正常运行约 3 分钟即可接近隧道，避免长时间空驶。
  continuityEndDistance: 1750,
  // 6 km压缩线路中设置5架通过信号机。均显示绿灯，仅作途中瞭望对象，
  // 不改变道口、隧道和钢轨反光异常的评分规则。
  throughSignals: Object.freeze([
    Object.freeze({ id: '2328', distance: 1800 }),
    Object.freeze({ id: '2316', distance: 2800 }),
    Object.freeze({ id: '2302', distance: 3800 }),
    Object.freeze({ id: '2288', distance: 4800 }),
    Object.freeze({ id: '2274', distance: 5800 }),
  ]),
  // 保留单架字段供旧的截图与调试脚本使用。
  throughSignalDistance: 1800,
  finishDistance: 6000,
  eventOrder: Object.freeze([
    LOOKOUT_EVENT_IDS.NORMAL_CROSSING,
    LOOKOUT_EVENT_IDS.TUNNEL_HAZARD,
    LOOKOUT_EVENT_IDS.RAIL_GLINT_BREAK,
    LOOKOUT_EVENT_IDS.INTRUSION_CROSSING,
  ]),
  events: Object.freeze([
    Object.freeze({
      id: LOOKOUT_EVENT_IDS.NORMAL_CROSSING,
      label: '正常道口瞭望',
      kind: 'normal-crossing',
      revealDistance: 1900,
      hazardDistance: 2200,
      passDistance: 2250,
      requiredHornCount: 1,
      weight: 10,
      points: Object.freeze({ horn: 10 }),
    }),
    Object.freeze({
      id: LOOKOUT_EVENT_IDS.TUNNEL_HAZARD,
      label: '隧道出口轮廓异常',
      kind: 'emergency',
      visualKind: 'tunnel',
      // 使用原 NEIYI 的100 m直线隧道轨道段和洞门，以完整三维姿态贴合近程线路。
      tunnelStartDistance: 3200,
      tunnelEndDistance: 3500,
      revealDistance: 3050,
      // 塌方位于出口外20 m；学生在洞内通过强光洞口轮廓的缺口预判。
      hazardDistance: 3520,
      passDistance: 3570,
      requiredHornCount: 1,
      weight: 20,
      points: Object.freeze({
        firstHorn: 2, emergency: 3, tractionZero: 2, stop: 3, independentFull: 2,
        restartTailBaseline: 1, restartIndependent: 1, restartTractionOne: 2,
        restartAutoRelease: 2, restartTailRelease: 2,
      }),
    }),
    Object.freeze({
      id: LOOKOUT_EVENT_IDS.RAIL_GLINT_BREAK,
      label: '钢轨光带中断',
      kind: 'emergency',
      visualKind: 'rail',
      // 隧道停车点之后留出约1.1 km恢复运行距离，避免刚起车即再次制动。
      // 正常反光提前500 m出现，学生完成坡道起车后仍有完整的观察和处置窗口。
      glintStartDistance: 4000,
      revealDistance: 4100,
      hazardDistance: 4600,
      passDistance: 4650,
      // 反光在危险边界处突然中断，后续180 m保持暗哑。
      glintBreakEndDistance: 4780,
      glintEndDistance: 5000,
      requiredHornCount: 1,
      weight: 20,
      points: Object.freeze({
        firstHorn: 2, emergency: 3, tractionZero: 2, stop: 3, independentFull: 2,
        restartTailBaseline: 1, restartIndependent: 1, restartTractionOne: 2,
        restartAutoRelease: 2, restartTailRelease: 2,
      }),
    }),
    Object.freeze({
      id: LOOKOUT_EVENT_IDS.INTRUSION_CROSSING,
      label: '道口人员或车辆侵线',
      kind: 'emergency',
      visualKind: 'intrusion-crossing',
      revealDistance: 5200,
      hazardDistance: 5600,
      passDistance: 5650,
      requiredHornCount: 2,
      weight: 30,
      points: Object.freeze({
        firstHorn: 2, secondHorn: 2, emergency: 4, tractionZero: 2, stop: 6, independentFull: 4,
        restartTailBaseline: 2, restartIndependent: 2, restartTractionOne: 2,
        restartAutoRelease: 2, restartTailRelease: 2,
      }),
    }),
  ]),
});

export function getLookoutEventConfig(id) {
  return LOOKOUT_TRAINING_CONFIG.events.find((event) => event.id === id) || null;
}

