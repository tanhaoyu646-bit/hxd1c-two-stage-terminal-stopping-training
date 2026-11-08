import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRailAlignedPath, cumulativePathDistances } from '../scripts/railAlignedPath.js';
import { SCENARIO } from '../scripts/terminalStoppingConfig.js';

const root = new URL('../', import.meta.url);
const sourceSceneUrl = new URL('assets/msts-neiyi-corridor/neiyi-lookout-full-scene.json', root);
const sourcePathUrl = new URL('assets/msts-neiyi/neiyi-5635-trackdb-path.json', root);
const outputSceneUrl = new URL('assets/msts-neiyi-corridor/neiyi-dashanpu-terminal-scene.json', root);
const outputPathUrl = new URL('assets/msts-neiyi/neiyi-5635-trackdb-path-aligned.json', root);

const WINDOW = SCENARIO.routeWindow;
const scene = JSON.parse(readFileSync(sourceSceneUrl, 'utf8'));
const path = JSON.parse(readFileSync(sourcePathUrl, 'utf8'));
const alignedPoints = buildRailAlignedPath(path.positions, scene.instances, { spacing: 5 });
const distances = cumulativePathDistances(alignedPoints);

const firstIndex = Math.max(1, distances.findIndex((distance) => distance >= WINDOW.start) - 1);
const lastMatch = distances.findIndex((distance) => distance > WINDOW.end);
const lastIndex = lastMatch === -1 ? alignedPoints.length - 1 : Math.min(alignedPoints.length - 1, lastMatch + 1);

function projectToTerminalWindow(position) {
  let best = null;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const a = alignedPoints[index - 1];
    const b = alignedPoints[index];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    const ratio = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((position[0] - a[0]) * dx + (position[1] - a[1]) * dy + (position[2] - a[2]) * dz) / lengthSquared))
      : 0;
    const x = a[0] + dx * ratio;
    const y = a[1] + dy * ratio;
    const z = a[2] + dz * ratio;
    const lateralDistance = Math.hypot(position[0] - x, position[1] - y, position[2] - z);
    if (!best || lateralDistance < best.lateralDistance) {
      best = {
        alongDistance: distances[index - 1] + Math.sqrt(lengthSquared) * ratio,
        lateralDistance,
      };
    }
  }
  return best;
}

function pointAtDistance(distance) {
  const clamped = Math.max(0, Math.min(distances.at(-1), distance));
  let low = 0;
  let high = distances.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (distances[middle] <= clamped) low = middle;
    else high = middle;
  }
  const span = distances[high] - distances[low];
  const ratio = span > 0 ? (clamped - distances[low]) / span : 0;
  return alignedPoints[low].map((value, axis) => value + (alignedPoints[high][axis] - value) * ratio);
}

const normalize = (vector) => {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function quaternionFromBasis(xAxis, yAxis, zAxis) {
  const m11 = xAxis[0]; const m12 = yAxis[0]; const m13 = zAxis[0];
  const m21 = xAxis[1]; const m22 = yAxis[1]; const m23 = zAxis[1];
  const m31 = xAxis[2]; const m32 = yAxis[2]; const m33 = zAxis[2];
  const trace = m11 + m22 + m33;
  let x; let y; let z; let w;
  if (trace > 0) {
    const scale = 2 * Math.sqrt(trace + 1);
    w = 0.25 * scale;
    x = (m32 - m23) / scale;
    y = (m13 - m31) / scale;
    z = (m21 - m12) / scale;
  } else if (m11 > m22 && m11 > m33) {
    const scale = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / scale;
    x = 0.25 * scale;
    y = (m12 + m21) / scale;
    z = (m13 + m31) / scale;
  } else if (m22 > m33) {
    const scale = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / scale;
    x = (m12 + m21) / scale;
    y = 0.25 * scale;
    z = (m23 + m32) / scale;
  } else {
    const scale = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / scale;
    x = (m13 + m31) / scale;
    y = (m23 + m32) / scale;
    z = 0.25 * scale;
  }
  return normalize([x, y, z, w]).map((value) => Math.round(value * 10_000_000) / 10_000_000);
}

function derivePlatformSegmentShape() {
  const source = scene.shapes[SCENARIO.sourcePlatform.sourceShape];
  if (!source) throw new Error(`Missing source platform shape: ${SCENARIO.sourcePlatform.sourceShape}`);
  const xValues = source.groups.flatMap((group) => (
    Array.from({ length: (group.positions?.length || 0) / 3 }, (_, index) => group.positions[index * 3])
  ));
  const minimumX = Math.min(...xValues);
  const maximumX = Math.max(...xValues);
  const scale = SCENARIO.sourcePlatform.segmentLength / (maximumX - minimumX);
  return {
    ...source,
    fileName: SCENARIO.sourcePlatform.shape,
    sha256: `derived:${source.sha256}:${SCENARIO.sourcePlatform.segmentLength}`,
    groups: source.groups.map((group) => ({
      ...group,
      positions: group.positions.map((value, index) => (
        index % 3 === 0 ? maximumX + (value - maximumX) * scale : value
      )),
    })),
  };
}

function buildPlatformInstances() {
  const instances = [];
  for (let index = 0; index < SCENARIO.sourcePlatform.segmentCount; index += 1) {
    const originDistance = SCENARIO.sourcePlatform.originWorldStart + index * SCENARIO.sourcePlatform.segmentStep;
    const point = pointAtDistance(originDistance);
    const end = pointAtDistance(originDistance + SCENARIO.sourcePlatform.segmentStep);
    const forward = normalize(end.map((value, axis) => value - point[axis]));
    const right = normalize(cross([0, 1, 0], forward));
    const up = normalize(cross(forward, right));
    const localX = forward.map((value) => -value);
    instances.push({
      uid: SCENARIO.sourcePlatform.uid + index,
      type: 'StaticObj',
      shape: SCENARIO.sourcePlatform.shape,
      position: point.map((value, axis) => Math.round((
        value + right[axis] * SCENARIO.sourcePlatform.lateral + up[axis] * SCENARIO.sourcePlatform.vertical
      ) * 1_000_000) / 1_000_000),
      quaternion: quaternionFromBasis(localX, up, right),
    });
  }
  return instances;
}

const corridorInstances = scene.instances.filter((instance) => {
  if (!Array.isArray(instance.position)) return false;
  const projection = projectToTerminalWindow(instance.position);
  return projection
    && projection.alongDistance >= WINDOW.start
    && projection.alongDistance <= WINDOW.end
    && projection.lateralDistance <= WINDOW.lateral;
}).filter((instance) => instance.uid !== SCENARIO.sourcePlatform.sourceUid);
const derivedPlatformShape = derivePlatformSegmentShape();
const instances = [...corridorInstances, ...buildPlatformInstances()];
const shapeNames = new Set(instances.map((instance) => instance.shape));
const availableShapes = { ...scene.shapes, [derivedPlatformShape.fileName]: derivedPlatformShape };
const shapes = Object.fromEntries(Object.entries(availableShapes).filter(([name]) => shapeNames.has(name)));
const triangleCount = Object.values(shapes).reduce((sum, shape) => (
  sum + (shape.groups || []).reduce((groupSum, group) => groupSum + Math.floor((group.positions?.length || 0) / 9), 0)
), 0);

const terminalScene = {
  ...scene,
  format: 'msts-terminal-scene-subset-v1',
  source: {
    route: scene.source?.route,
    worldTiles: (scene.source?.worldTiles || []).map(({ worldTile, worldSha256, tileX, tileZ }) => ({
      worldTile, worldSha256, tileX, tileZ,
    })),
    origin: scene.source?.origin,
    originTile: scene.source?.originTile,
    coordinateTransform: scene.source?.coordinateTransform,
    derivedFrom: 'neiyi-lookout-full-scene.json',
    routeWindow: WINDOW,
  },
  summary: {
    ...scene.summary,
    shapeCount: Object.keys(shapes).length,
    instanceCount: instances.length,
    triangleCount,
    routeWindow: WINDOW,
  },
  shapes,
  instances,
};
const alignedPath = {
  ...path,
  format: 'msts-trackdb-aligned-path-v1',
  summary: {
    ...path.summary,
    aligned: true,
    spacing: 5,
    sampledPointCount: alignedPoints.length,
    pathLength: distances.at(-1),
  },
  positions: alignedPoints.flat(),
};

writeFileSync(outputSceneUrl, JSON.stringify(terminalScene));
writeFileSync(outputPathUrl, JSON.stringify(alignedPath));
console.log(JSON.stringify({
  scene: {
    output: fileURLToPath(outputSceneUrl),
    instances: instances.length,
    shapes: Object.keys(shapes).length,
    bytes: Buffer.byteLength(JSON.stringify(terminalScene)),
  },
  path: {
    output: fileURLToPath(outputPathUrl),
    points: alignedPoints.length,
    length: distances.at(-1),
    bytes: Buffer.byteLength(JSON.stringify(alignedPath)),
  },
}, null, 2));
