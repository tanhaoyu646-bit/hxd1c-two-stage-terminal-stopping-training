import { SCENARIO, brakingDistanceForSpeed } from './terminalStoppingConfig.js?v=two-stage-3';

const between = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const displayedBetween = (value, min, max) => Number.isFinite(value) && Math.round(value) >= min && Math.round(value) <= max;
const clampScore = (value, maximum) => Math.max(0, Math.min(maximum, Math.round(value)));

function tractionRelease(events, firstBrake) {
  if (!firstBrake) return { correctOrder: false, delayed: false, progressive: false, target: null };
  const changes = events.filter((event) => event.type === 'traction' && event.elapsed >= firstBrake.elapsed);
  const reductions = changes.filter((event) => Number(event.previous?.traction) > Number(event.value) && Number(event.value) >= 0);
  const firstReduction = reductions[0] || null;
  const target = changes.find((event) => Number(event.value) <= 1) || null;
  const throughTarget = target ? reductions.filter((event) => event.elapsed <= target.elapsed) : [];
  const progressive = Boolean(target && throughTarget.length && throughTarget.every((event) => Number(event.previous?.traction) - Number(event.value) === 1));
  return {
    correctOrder: Number(firstBrake.traction) > 1 && Boolean(firstReduction && target),
    delayed: Boolean(firstReduction && firstReduction.elapsed - firstBrake.elapsed >= SCENARIO.tractionReleaseDelay),
    progressive,
    target,
  };
}

function twoStageEvents(events) {
  const applications = events.filter((event) => event.type === 'brake-application');
  const firstBrake = applications.find((event) => event.ordinal === 1) || null;
  const secondBrake = applications.find((event) => event.ordinal === 2) || null;
  const firstRelease = events.find((event) => event.type === 'brake-release' && event.ordinal === 1) || null;
  const charged = events.find((event) => event.type === 'brake-pipe-charged') || null;
  const firstReleaseIndex = firstRelease ? events.indexOf(firstRelease) : -1;
  const secondBrakeIndex = secondBrake ? events.indexOf(secondBrake) : events.length;
  const tailQuery = events.find((event, index) => event.type === 'cir-action'
    && event.action?.type === 'tail-query'
    && firstReleaseIndex >= 0
    && index > firstReleaseIndex
    && index < secondBrakeIndex) || null;
  const queryPressure = Number(tailQuery?.action?.pressure);
  const tailQueryValid = Boolean(tailQuery
    && Number.isFinite(queryPressure)
    && queryPressure >= SCENARIO.tailQueryMinimumPressure
    && Math.abs(Number(tailQuery.trainPipe) - queryPressure) <= SCENARIO.tailQueryMaximumDifference);
  const cruiseNotch = firstRelease?.traction === 1
    ? firstRelease
    : events.find((event, index) => event.type === 'traction'
      && event.value === 1
      && firstReleaseIndex >= 0
      && index > firstReleaseIndex
      && index < secondBrakeIndex) || null;
  return { applications, firstBrake, secondBrake, firstRelease, charged, tailQuery, tailQueryValid, cruiseNotch };
}

export class TerminalStoppingAssessment {
  constructor(simulation) { this.simulation = simulation; }

  progress(state = this.simulation.state) {
    const events = state.events;
    const stage = twoStageEvents(events);
    const release = tractionRelease(events, stage.firstBrake);
    const checks = [
      events.some((event) => event.type === 'lkj-open'),
      events.some((event) => event.type === 'callout'),
      release.correctOrder && release.delayed && release.progressive,
      Boolean(stage.firstBrake),
      Boolean(stage.firstRelease && displayedBetween(stage.firstRelease.speed, SCENARIO.firstReleaseMinimumSpeed, SCENARIO.firstReleaseMaximumSpeed)),
      Boolean(stage.charged),
      Boolean(stage.cruiseNotch),
      stage.tailQueryValid,
      Boolean(stage.secondBrake),
      events.some((event) => event.type === 'train-stop'),
      events.some((event) => event.type === 'attempt-complete' && event.secured),
      state.completed,
    ];
    return { done: checks.filter(Boolean).length, total: checks.length, checks };
  }

  result(state = this.simulation.state) {
    const events = state.events;
    const stage = twoStageEvents(events);
    const release = tractionRelease(events, stage.firstBrake);
    const entrySignal = events.find((event) => event.type === 'entry-signal');
    const trainStop = events.find((event) => event.type === 'train-stop');
    const additions = events.filter((event) => event.type === 'brake-addition' && (!trainStop || event.elapsed < trainStop.elapsed));
    const releasesAfterSecond = stage.secondBrake
      ? events.filter((event) => event.type === 'brake-release' && event.elapsed > stage.secondBrake.elapsed && (!trainStop || event.elapsed < trainStop.elapsed))
      : [];
    const secured = events.some((event) => event.type === 'attempt-complete' && event.secured);

    let confirmation = 10;
    if (!events.some((event) => event.type === 'lkj-open')) confirmation -= 3;
    if (!events.some((event) => event.type === 'callout')) confirmation -= 4;
    if (!entrySignal || entrySignal.speed > SCENARIO.maximumEntrySpeed) confirmation -= 3;

    let firstStage = 20;
    if (!release.correctOrder) firstStage -= 2;
    if (!release.delayed) firstStage -= 2;
    if (!release.progressive) firstStage -= 2;
    const selectedBrakeDistance = stage.firstBrake ? brakingDistanceForSpeed(stage.firstBrake.speed) : Number.NaN;
    if (!stage.firstBrake || Math.abs(stage.firstBrake.remaining - selectedBrakeDistance) > 20) firstStage -= 8;
    if (!stage.firstBrake || !between(stage.firstBrake.speed, 39, SCENARIO.maximumEntrySpeed)) firstStage -= 4;
    if (stage.firstBrake && stage.firstBrake.value !== 1) firstStage -= 4;

    let releaseAndCharge = 20;
    if (!stage.firstRelease || !displayedBetween(stage.firstRelease.speed, SCENARIO.firstReleaseMinimumSpeed, SCENARIO.firstReleaseMaximumSpeed)) releaseAndCharge -= 8;
    if (!stage.charged || (stage.secondBrake && stage.charged.elapsed >= stage.secondBrake.elapsed)) releaseAndCharge -= 6;
    if (!stage.cruiseNotch) releaseAndCharge -= 3;
    if (!stage.secondBrake || !between(stage.secondBrake.speed, 9, 11)) releaseAndCharge -= 3;

    let secondStage = 20;
    if (!stage.tailQueryValid) secondStage -= 8;
    if (!stage.secondBrake || Math.abs(stage.secondBrake.remaining - SCENARIO.secondBrakeRemaining) > 3) secondStage -= 7;
    if (!stage.secondBrake || stage.secondBrake.value !== 1) secondStage -= 3;
    if (stage.secondBrake && stage.secondBrake.traction !== 0) secondStage -= 2;
    if (additions.length || releasesAfterSecond.length) secondStage -= 4;
    if (events.some((event) => event.type === 'electric-brake-use')) secondStage -= 4;
    if (events.some((event) => event.type === 'independent-brake-moving')) secondStage -= 4;

    const absoluteError = Math.abs(state.stopError ?? Number.POSITIVE_INFINITY);
    let accuracy = 0;
    if (absoluteError <= 0.5) accuracy = 20;
    else if (absoluteError <= 1) accuracy = 18;
    else if (absoluteError <= 2) accuracy = 15;
    else if (absoluteError <= 5) accuracy = 8;
    else if (absoluteError <= 10) accuracy = 3;

    let smoothness = 10;
    const maxDeceleration = Math.abs(Math.min(0, ...state.samples.map((sample) => sample.acceleration || 0)));
    if (maxDeceleration > 0.7) smoothness -= 3;
    if (maxDeceleration > 1) smoothness -= 3;
    if (!secured) smoothness -= 4;

    const categories = [
      { name: '瞭望确认', score: clampScore(confirmation, 10), maximum: 10 },
      { name: '第一次制动', score: clampScore(firstStage, 20), maximum: 20 },
      { name: '缓解充风与低速走行', score: clampScore(releaseAndCharge, 20), maximum: 20 },
      { name: '列尾查询与第二次制动', score: clampScore(secondStage, 20), maximum: 20 },
      { name: '停车精度', score: clampScore(accuracy, 20), maximum: 20 },
      { name: '平稳与防溜', score: clampScore(smoothness, 10), maximum: 10 },
    ];

    const safetyEvents = events.filter((event) => event.type === 'target-overrun'
      || event.type === 'restart-attempt'
      || event.type === 'direction-while-moving'
      || (event.type === 'lkj-level' && ['service', 'emergency'].includes(event.to)));
    const redline = safetyEvents.length > 0 || absoluteError > 10;
    const essentialComplete = Boolean(stage.firstBrake && stage.firstRelease && stage.charged && stage.tailQueryValid && stage.secondBrake);
    let score = categories.reduce((sum, category) => sum + category.score, 0);
    if (redline) score = Math.min(score, 59);
    const qualified = state.stopped && essentialComplete && !redline && absoluteError <= SCENARIO.passTolerance && score >= 80;

    return {
      score,
      qualified,
      redline,
      categories,
      stopError: state.stopError,
      stopDistance: state.stopDistance,
      duration: state.elapsed,
      maxDeceleration,
      secured,
      summary: qualified ? '考评合格' : '考评不合格',
      safetyEvents,
      checkpoints: {
        entrySpeed: entrySignal?.speed ?? null,
        firstBrakeSpeed: stage.firstBrake?.speed ?? null,
        firstBrakeRemaining: stage.firstBrake?.remaining ?? null,
        firstReleaseSpeed: stage.firstRelease?.speed ?? null,
        chargedTailPressure: stage.charged?.tailPipe ?? null,
        tailQueryPressure: stage.tailQuery?.action?.pressure ?? null,
        secondBrakeSpeed: stage.secondBrake?.speed ?? null,
        secondBrakeRemaining: stage.secondBrake?.remaining ?? null,
      },
    };
  }
}
