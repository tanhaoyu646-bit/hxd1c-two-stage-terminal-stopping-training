export const TRAINING_CONFIG = Object.freeze({
  title: '旅客列车平稳起动虚拟实训',
  subtitle: 'HXD1C 驾驶台功能原型 · 既有发车作业线路载体',
  trainNo: 'K2026次（教学编组）',
  locomotive: 'HXD1C（功能原型）',
  consistCars: 12,
  targetSpeed: 10,
  maxFinishSpeed: 15,
  rearLookSeconds: 2.5,
  route: {
    departureSignalDistance: 454.14,
    departureSignalSourceUid: 52244,
    departureSignalExpectedDistance: 454.14,
    neighborSignalSourceUid: 52245,
    neighborSignalExpectedDistance: 459.44,
    firstBlockLength: 9135,
    firstBlockEndDistance: 9589.14,
  },
  comfort: {
    // 仅用于本网页相对评价，并非规章或车辆型式试验限值。
    preferredAcceleration: 0.28,
    maxAcceleration: 0.42,
    preferredJerk: 0.22,
    maxJerk: 0.48,
  },
});

// mstsRouteScene 保持这一名称，避免线路模块与教学业务相互耦合。
export const ROUTE_CONTEXT = Object.freeze({
  ...TRAINING_CONFIG.route,
  weatherSignalClearDistance: 50,
  weatherSignalApproachDistance: 150,
});

