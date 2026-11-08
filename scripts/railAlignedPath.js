const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a, b, scale) => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (value) => Math.hypot(value[0], value[1], value[2]);
const normalize = (value, fallback = [0, 0, 1]) => {
  const magnitude = length(value);
  return magnitude > 1e-7 ? value.map((item) => item / magnitude) : [...fallback];
};

function rotateLocalForward(quaternion) {
  const [qx, qy, qz, qw] = quaternion;
  // 将 Three.js/MSTS 对象的本地 +Z 轴旋转到世界坐标。
  return normalize([
    2 * (qx * qz + qw * qy),
    2 * (qy * qz - qw * qx),
    1 - 2 * (qx * qx + qy * qy),
  ]);
}

function desiredTangent(points, index) {
  if (index === 0) return normalize(subtract(points[1], points[0]));
  if (index === points.length - 1) return normalize(subtract(points[index], points[index - 1]));
  return normalize(subtract(points[index + 1], points[index - 1]));
}

function findTrackTangent(point, desired, trackInstances, maximumDistance) {
  let best = null;
  for (const instance of trackInstances) {
    if (!Array.isArray(instance.position) || !Array.isArray(instance.quaternion)) continue;
    const offset = subtract(instance.position, point);
    const distance = length(offset);
    if (distance > maximumDistance) continue;
    let axis = rotateLocalForward(instance.quaternion);
    const alignment = dot(axis, desired);
    if (alignment < 0) axis = axis.map((value) => -value);
    const score = distance + (1 - Math.abs(alignment)) * 12;
    if (!best || score < best.score) best = { axis, score };
  }
  return best?.axis || desired;
}

function hermitePoint(start, end, startTangent, endTangent, scale, ratio) {
  const t2 = ratio * ratio;
  const t3 = t2 * ratio;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + ratio;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [
    h00 * start[0] + h10 * startTangent[0] * scale + h01 * end[0] + h11 * endTangent[0] * scale,
    h00 * start[1] + h10 * startTangent[1] * scale + h01 * end[1] + h11 * endTangent[1] * scale,
    h00 * start[2] + h10 * startTangent[2] * scale + h01 * end[2] + h11 * endTangent[2] * scale,
  ];
}

export function buildRailAlignedPath(flatPositions, instances, options = {}) {
  if (!Array.isArray(flatPositions) || flatPositions.length < 6 || flatPositions.length % 3 !== 0) {
    throw new Error('轨道中心线数据格式无效');
  }
  const spacing = Math.max(2, Number(options.spacing) || 5);
  const maximumTangentDistance = Math.max(0.5, Number(options.maximumTangentDistance) || 4);
  const controls = Array.from(
    { length: flatPositions.length / 3 },
    (_, index) => flatPositions.slice(index * 3, index * 3 + 3),
  );
  // MSTS 把铁路与道路都导出为 TrackObj。如果把 JP2Rd 道路的方向当成钢轨切线，
  // Hermite 中心线会在平交口被拉离钢轨。只允许 A1t/A2t/A3t 系列的原始铁路构件参与对齐。
  const trackInstances = (instances || []).filter((instance) => (
    instance.type === 'TrackObj' && /^A\d+t/i.test(instance.shape || '')
  ));
  const tangents = controls.map((point, index) => {
    const desired = desiredTangent(controls, index);
    return findTrackTangent(point, desired, trackInstances, maximumTangentDistance);
  });
  const points = [controls[0]];
  for (let index = 1; index < controls.length; index += 1) {
    const start = controls[index - 1];
    const end = controls[index];
    const chord = subtract(end, start);
    const chordLength = length(chord);
    if (chordLength < 1e-6) continue;
    const chordDirection = normalize(chord);
    const startTangent = dot(tangents[index - 1], chordDirection) < 0
      ? tangents[index - 1].map((value) => -value)
      : tangents[index - 1];
    const endTangent = dot(tangents[index], chordDirection) < 0
      ? tangents[index].map((value) => -value)
      : tangents[index];
    const sampleCount = Math.max(1, Math.ceil(chordLength / spacing));
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      points.push(hermitePoint(start, end, startTangent, endTangent, chordLength, sample / sampleCount));
    }
  }
  return points;
}

export function cumulativePathDistances(points) {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + length(subtract(points[index], points[index - 1])));
  }
  return distances;
}
