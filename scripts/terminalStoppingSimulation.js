import {
  BRAKE_POSITIONS,
  SCENARIO,
  DYNAMIC_BRAKE_MAX,
  TRACTION_MAX,
  brakingDistanceForSpeed,
  lkjCurvesAt,
  lkjControlLimit,
  phaseAt,
  remainingToTarget,
  signalAt,
  trainingBand,
  tractionTargetSpeed,
} from './terminalStoppingConfig.js?v=two-stage-2';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class TerminalStoppingSimulation extends EventTarget {
  constructor(mode = 'training') {
    super();
    this.reset(mode);
  }

  reset(mode = this.state?.mode || 'training') {
    this.scenario = SCENARIO;
    this.state = {
      scenarioId: SCENARIO.id,
      mode: mode === 'assessment' ? 'assessment' : 'training',
      status: 'ready',
      workflowStage: 'confirm',
      elapsed: 0,
      secureElapsed: 0,
      distance: 0,
      speed: SCENARIO.initialSpeed,
      acceleration: 0,
      traction: SCENARIO.initialTraction,
      tractionTargetSpeed: tractionTargetSpeed(SCENARIO.initialTraction),
      balanceSpeed: tractionTargetSpeed(SCENARIO.initialTraction),
      direction: 'F',
      autoBrake: 0,
      brakeApplicationOrdinal: 0,
      independentBrake: 0,
      sideRelease: false,
      equalizingReservoir: 600,
      trainPipe: 600,
      tailPipe: 600,
      brakeCylinder: 0,
      locomotiveCylinder: 0,
      mainReservoir: 900,
      netVoltage: 2500,
      tractionCurrent: 0,
      tractionForce: 0,
      electricBrakeForce: 0,
      signal: signalAt(0),
      phase: phaseAt(0),
      targetBand: trainingBand(SCENARIO.targetDistance),
      lkjLimit: lkjControlLimit(0),
      lkjLineLimit: lkjCurvesAt(0).lineLimit,
      lkjModeLimit: lkjCurvesAt(0).modeLimit,
      lkjLevel: 'normal',
      lkjAcknowledged: true,
      lkjForcedBrake: 0,
      lkjOpenCount: 0,
      calloutCount: 0,
      stopped: false,
      stopDistance: null,
      stopError: null,
      stopSpeed: null,
      teachingPause: null,
      completed: false,
      events: [],
      samples: [],
    };
    this.lastSampleAt = -1;
    this.crossed = new Set();
    this.teachingSeen = new Set();
    this.dispatchEvent(new CustomEvent('reset', { detail: this.state }));
    return this.state;
  }

  start() {
    if (this.state.status === 'ready') {
      this.state.status = 'running';
      this.log('attempt-start', { mode: this.state.mode });
      if (this.state.mode === 'training') this.pauseTeaching('brake-strength');
      this.emitChange();
    }
  }

  command(type, value) {
    const s = this.state;
    if (s.completed) return false;
    if (type === 'teaching-continue') {
      if (s.mode !== 'training' || s.status !== 'teaching-paused' || !s.teachingPause) return false;
      const lessonId = s.teachingPause.id;
      this.teachingSeen.add(lessonId);
      this.log('teaching-continue', { lesson: lessonId });
      s.teachingPause = null;
      s.status = 'running';
      if (lessonId === 'stop-alignment') this.maybeCompleteSecure();
      this.emitChange();
      return true;
    }
    if (s.status === 'ready' && type !== 'lkj-open') this.start();
    const previous = {
      traction: s.traction,
      autoBrake: s.autoBrake,
      independentBrake: s.independentBrake,
      sideRelease: s.sideRelease,
    };

    if (type === 'traction') {
      const next = clamp(Math.round(Number(value) || 0), -DYNAMIC_BRAKE_MAX, TRACTION_MAX);
      if (s.stopped && next !== 0) this.log('restart-attempt', { value: next });
      if (!s.stopped) {
        s.traction = next;
        s.tractionTargetSpeed = tractionTargetSpeed(next);
      }
      if (next < 0 && s.speed > 1) this.log('electric-brake-use', { value: next });
    } else if (type === 'auto-brake') {
      s.autoBrake = clamp(Math.round(Number(value) || 0), 0, 5);
      const application = s.autoBrake > 0 && previous.autoBrake === 0;
      if (application) {
        const previousApplications = s.events.filter((event) => event.type === 'brake-application').length;
        s.brakeApplicationOrdinal = previousApplications + 1;
        this.log('brake-application', { ordinal: s.brakeApplicationOrdinal, value: s.autoBrake, traction: s.traction });
        s.workflowStage = previousApplications === 0 ? 'first-brake' : 'second-brake';
      }
      if (s.autoBrake === 0 && previous.autoBrake > 0) {
        this.log('brake-release', { ordinal: s.brakeApplicationOrdinal, from: previous.autoBrake });
        if (s.brakeApplicationOrdinal === 1) s.workflowStage = 'recharge';
      }
      if (s.autoBrake > previous.autoBrake && previous.autoBrake > 0) {
        this.log('brake-addition', { from: previous.autoBrake, to: s.autoBrake });
        s.workflowStage = 'correction';
      }
    } else if (type === 'independent-brake') {
      s.independentBrake = clamp(Math.round(Number(value) || 0), 0, 5);
      if (!s.stopped && s.speed >= 3 && s.independentBrake > previous.independentBrake) {
        this.log('independent-brake-moving', { value: s.independentBrake });
      }
    } else if (type === 'side-release') {
      s.sideRelease = Boolean(value);
    } else if (type === 'direction') {
      if (s.speed > 1 || s.traction !== 0) {
        this.log('direction-while-moving', { value, blocked: true });
        this.emitChange();
        return false;
      }
      s.direction = ['F', 'N', 'R'].includes(value) ? value : s.direction;
    } else if (type === 'callout') {
      s.calloutCount += 1;
      this.log('callout', { signal: s.signal.id, aspect: s.signal.aspect });
    } else if (type === 'lkj-open') {
      s.lkjOpenCount += 1;
      this.log('lkj-open');
    } else if (type === 'lkj-ack') {
      s.lkjAcknowledged = true;
      this.log('lkj-ack', { level: s.lkjLevel });
    } else if (type === 'lkj-relief') {
      if (s.lkjLevel === 'normal' && s.speed <= s.lkjLimit + 1) {
        s.lkjForcedBrake = 0;
        this.log('lkj-relief', { accepted: true });
      } else this.log('lkj-relief', { accepted: false });
    } else if (type === 'cir-action') {
      this.log('cir-action', { action: value, trainPipe: s.trainPipe, tailPipe: s.tailPipe });
    } else if (type === 'horn-start' || type === 'horn-stop') {
      s.hornActive = type === 'horn-start';
      this.log(type);
    } else if (type === 'lkj-start-align') {
      this.log('lkj-start-align');
    } else if (type === 'lkj-position-correct') {
      this.log('lkj-position-correct', { method: value || 'auto' });
    } else if (type === 'lkj-mark') {
      this.log('lkj-mark');
    } else if (type === 'lkj-patrol') {
      this.log('lkj-patrol');
    } else return false;

    if (['traction', 'auto-brake', 'independent-brake', 'side-release'].includes(type)) {
      const key = type === 'auto-brake' ? 'autoBrake' : type === 'independent-brake' ? 'independentBrake' : type === 'side-release' ? 'sideRelease' : 'traction';
      const before = type === 'side-release' ? Number(previous.sideRelease) : Number(previous[key]);
      const after = type === 'side-release' ? Number(s.sideRelease) : Number(s[key]);
      if (before === after) return false;
      this.log(type, { value: s[key], previous });
    }
    this.maybeCompleteSecure();
    this.emitChange();
    return true;
  }

  log(type, data = {}) {
    const s = this.state;
    s.events.push({ type, elapsed: s.elapsed, distance: s.distance, remaining: remainingToTarget(s.distance), speed: s.speed, ...data });
  }

  tick(dt) {
    const s = this.state;
    if (s.status !== 'running' || s.completed) return;
    dt = clamp(Number(dt) || 0, 0, 0.08);
    s.elapsed += dt;
    if (s.stopped) s.secureElapsed += dt;

    const requestedReduction = BRAKE_POSITIONS[Math.max(s.autoBrake, s.lkjForcedBrake)]?.reduction || 0;
    const targetPipe = Math.max(0, 600 - requestedReduction);
    const pipeTau = targetPipe < s.trainPipe ? 5.4 : 14;
    s.trainPipe += (targetPipe - s.trainPipe) * (1 - Math.exp(-dt / pipeTau));
    s.tailPipe += (s.trainPipe - s.tailPipe) * (1 - Math.exp(-dt / 2.2));
    s.equalizingReservoir += (targetPipe - s.equalizingReservoir) * (1 - Math.exp(-dt / 2.4));
    const automaticCylinder = clamp((600 - s.trainPipe) / 170 * 350, 0, 430);
    const independentCylinder = s.independentBrake * 62;
    s.brakeCylinder += (Math.max(automaticCylinder, independentCylinder) - s.brakeCylinder) * (1 - Math.exp(-dt / 2.1));
    const desiredLoco = s.sideRelease ? independentCylinder : Math.max(automaticCylinder, independentCylinder);
    s.locomotiveCylinder += (desiredLoco - s.locomotiveCylinder) * (1 - Math.exp(-dt / 1.4));

    const previousDistance = s.distance;
    const previousSpeed = s.speed;
    if (!s.stopped) {
      const speedMps = s.speed / 3.6;
      const rollingResistance = s.speed > 0.2 ? 28_000 + speedMps * speedMps * 8 : 0;
      const mass = 900_000;
      const speedError = s.tractionTargetSpeed - s.speed;
      const tractionEnvelope = Math.min(520_000, 7_200_000 / Math.max(.5, speedMps));
      const tractionAuthority = s.traction > 0 ? clamp(.72 + .28 * s.traction / TRACTION_MAX, 0, 1) : 0;
      const holdingForce = rollingResistance;
      const controllerGain = s.traction === 1 && s.brakeApplicationOrdinal >= 1 ? .022 : .0075;
      const controllerForce = holdingForce + speedError * mass * controllerGain;
      // 与途中调速项目一致：正级位是目标速度给定。达到或超过给定速度即卸载，
      // 低于目标速度时才按阻力和速度偏差恢复牵引力。
      const tractionForce = s.traction > 0 && speedError > 0 && s.autoBrake === 0 && s.lkjForcedBrake === 0 && s.lkjLevel !== 'unload'
        ? clamp(controllerForce, 0, tractionAuthority * tractionEnvelope)
        : 0;
      const electricBrake = s.traction < 0 ? Math.abs(s.traction) * 42_000 : 0;
      s.tractionForce = tractionForce;
      s.electricBrakeForce = electricBrake;
      s.tractionCurrent += (tractionForce / 310 - s.tractionCurrent) * (1 - Math.exp(-dt / .45));
      s.balanceSpeed = s.tractionTargetSpeed;
      // 标准旅客列车工况：40 km/h、50 kPa 初减压，制动距离约280 m。
      // 保留列车管传播和制动缸建立过程，只校准稳定制动力。
      const lowStageForce = automaticCylinder * 2_126;
      const highStageForce = Math.max(0, automaticCylinder - 110) * 4_000;
      const secondBrakeMultiplier = s.brakeApplicationOrdinal >= 2 ? SCENARIO.secondBrakeForceMultiplier : 1;
      const pneumaticForce = (lowStageForce + highStageForce) * secondBrakeMultiplier;
      const netForce = tractionForce - electricBrake - rollingResistance - pneumaticForce;
      const newAcceleration = netForce / mass;
      s.acceleration += (newAcceleration - s.acceleration) * (1 - Math.exp(-dt / 0.65));
      s.speed = Math.max(0, s.speed + s.acceleration * dt * 3.6);
      s.distance += s.speed / 3.6 * dt;
    } else {
      s.speed = 0;
      s.acceleration = 0;
    }

    const remaining = remainingToTarget(s.distance);
    s.targetBand = trainingBand(remaining);
    s.phase = phaseAt(s.distance, s.stopped);
    s.signal = signalAt(s.distance);
    const lkjCurves = lkjCurvesAt(s.distance);
    s.lkjLineLimit = lkjCurves.lineLimit;
    s.lkjModeLimit = lkjCurves.modeLimit;
    s.lkjLimit = lkjCurves.activeLimit;
    this.updateWorkflow(previousDistance, previousSpeed);
    this.updateLkjProtection();

    if (s.elapsed - this.lastSampleAt >= 0.25) {
      this.lastSampleAt = s.elapsed;
      s.samples.push({
        elapsed: s.elapsed,
        distance: s.distance,
        remaining,
        speed: s.speed,
        target: s.targetBand.target,
        limit: s.lkjLimit,
        pipe: s.trainPipe,
        brake: s.autoBrake,
        traction: s.traction,
        acceleration: s.acceleration,
      });
      if (s.samples.length > 1_500) s.samples.shift();
    }

    if (!s.stopped && s.speed <= 0.18 && s.distance > SCENARIO.firstBrakePoint) this.registerStop();
    if (!s.stopped && s.distance > SCENARIO.targetDistance + 5 && s.speed > 3 && !this.crossed.has('overrun')) {
      this.crossed.add('overrun');
      this.log('target-overrun');
    }
    if (!s.stopped && s.distance > SCENARIO.finishDistance) s.lkjForcedBrake = 5;
    if (s.stopped) this.maybeCompleteSecure();
    if (s.mode === 'assessment' && s.stopped && s.secureElapsed >= 12) this.complete();
    this.emitChange();
  }

  updateWorkflow(previousDistance, previousSpeed) {
    const s = this.state;
    const checkpoints = [
      ['entry-signal', SCENARIO.entryDistance],
      ['first-brake-point', SCENARIO.firstBrakePoint],
      ['tail-query-point', SCENARIO.tailQueryPoint],
      ['second-brake-point', SCENARIO.secondBrakePoint],
      ['target-point', SCENARIO.targetDistance],
    ];
    for (const [id, distance] of checkpoints) {
      if (!this.crossed.has(id) && previousDistance < distance && s.distance >= distance) {
        this.crossed.add(id);
        this.log(id, { checkpointDistance: distance });
      }
    }
    const applications = s.events.filter((event) => event.type === 'brake-application');
    const firstBrake = applications.find((event) => event.ordinal === 1);
    const firstRelease = s.events.find((event) => event.type === 'brake-release' && event.ordinal === 1);
    const crossedReleaseWindow = firstBrake
      && !firstRelease
      && previousSpeed > SCENARIO.firstReleaseMaximumSpeed
      && s.speed <= SCENARIO.firstReleaseMaximumSpeed
      && !this.crossed.has('release-window');
    if (crossedReleaseWindow) {
      this.crossed.add('release-window');
      this.log('release-window');
    }
    const charged = firstRelease
      && s.trainPipe >= 595
      && s.tailPipe >= SCENARIO.tailQueryMinimumPressure
      && Math.abs(s.trainPipe - s.tailPipe) <= SCENARIO.tailQueryMaximumDifference;
    if (charged && !this.crossed.has('brake-pipe-charged')) {
      this.crossed.add('brake-pipe-charged');
      this.log('brake-pipe-charged', { trainPipe: s.trainPipe, tailPipe: s.tailPipe });
    }
    if (s.mode === 'training') {
      if (previousDistance < SCENARIO.entryDistance && s.distance >= SCENARIO.entryDistance) this.pauseTeaching('entry-reference');
      else if (previousDistance < SCENARIO.firstBrakePoint && s.distance >= SCENARIO.firstBrakePoint) this.pauseTeaching('first-brake');
      else if (crossedReleaseWindow) this.pauseTeaching('first-release');
      else if (charged) this.pauseTeaching('recharge-complete');
      else if (previousDistance < SCENARIO.tailQueryPoint && s.distance >= SCENARIO.tailQueryPoint) this.pauseTeaching('tail-pressure');
      else if (previousDistance < SCENARIO.secondBrakePoint && s.distance >= SCENARIO.secondBrakePoint) this.pauseTeaching('second-brake');
    }
    if (!s.stopped) {
      if (applications.length >= 2) s.workflowStage = 'second-brake';
      else if (s.distance >= SCENARIO.tailQueryPoint) s.workflowStage = 'tail-query';
      else if (firstRelease) s.workflowStage = charged ? 'low-speed-run' : 'recharge';
      else if (firstBrake) s.workflowStage = 'first-brake';
      else if (s.distance >= 200 && s.workflowStage === 'confirm') s.workflowStage = 'prepare';
    }
  }

  registerStop() {
    const s = this.state;
    s.stopped = true;
    s.status = 'running';
    s.workflowStage = 'secure';
    s.stopDistance = s.distance;
    s.stopError = s.distance - SCENARIO.targetDistance;
    s.stopSpeed = s.speed;
    s.speed = 0;
    this.log('train-stop', { stopDistance: s.stopDistance, stopError: s.stopError });
    if (s.mode === 'training') this.pauseTeaching('stop-alignment');
    this.maybeCompleteSecure();
  }

  pauseTeaching(id) {
    const s = this.state;
    if (s.mode !== 'training' || this.teachingSeen.has(id) || s.teachingPause) return;
    const remaining = Math.max(0, remainingToTarget(s.distance));
    const exitRemaining = Math.max(0, SCENARIO.exitSignalDistance - s.distance);
    const stopToExit = SCENARIO.exitSignalDistance - SCENARIO.targetDistance;
    const selectedBrakeDistance = brakingDistanceForSpeed(s.speed);
    const lessons = {
      'brake-strength': {
        title: '先判断列车制动力',
        body: '实际值乘应通过始发或接班后的贯通试验判断制动力。自阀减压50 kPa后，10秒内速度下降超过5 km/h，可作为标准制动力参考。',
        focus: '本场景采用标准旅客列车：一段制动基准距离约280 m；两段制动第一次制动在此基础上提前120 m，即距标约400 m。',
      },
      'entry-reference': {
        title: '确定第一次制动地点',
        body: `已越过进站信号机，机车信号转红黄灯。本工况一段制动基准280 m，两段制动在此基础上提前${SCENARIO.firstBrakeExtraDistance} m。`,
        focus: `距停车标约${SCENARIO.standardBrakeDistance} m、即LKJ距出站约${(stopToExit + SCENARIO.standardBrakeDistance).toFixed(0)} m时，以约40 km/h、50 kPa实施第一次初制动。`,
      },
      'first-brake': {
        title: '实施第一次初制动',
        body: `当前LKJ距出站约${exitRemaining.toFixed(0)} m、距停车标约${remaining.toFixed(0)} m、速度${s.speed.toFixed(1)} km/h；按当前速度计算的制动距离约${selectedBrakeDistance.toFixed(0)} m。`,
        focus: `自阀置初制位形成约50 kPa减压，保持平稳；列车稳定降速约${SCENARIO.tractionReleaseDelay}秒后，逐级退回牵引手柄至零位。`,
      },
      'first-release': {
        title: '第一次制动缓解',
        body: `速度已降至${s.speed.toFixed(1)} km/h，进入${SCENARIO.firstReleaseMaximumSpeed}–${SCENARIO.firstReleaseMinimumSpeed} km/h缓解窗口。`,
        focus: '确认自阀排风已经停止后，将自阀移至运转位充风；随后将主手柄置牵引1级，以10 km/h目标速度平稳走行。',
      },
      'recharge-complete': {
        title: '确认列车管充风',
        body: `列车管约${s.trainPipe.toFixed(0)} kPa、列尾约${s.tailPipe.toFixed(0)} kPa，已恢复到可进行第二次制动的状态。`,
        focus: '继续以牵引1级维持约10 km/h。第二次制动前必须在CIR中查询列尾风压，确认尾部风压充足。',
      },
      'tail-pressure': {
        title: '第二次制动前查询列尾',
        body: `当前距停车标约${remaining.toFixed(0)} m。第二次制动前应确认列车管已经充满。`,
        focus: '继续运行前打开CIR，按“风压查询”键；列尾风压不低于590 kPa、与机车列车管压差不超过20 kPa后，方可准备第二次制动。',
      },
      'second-brake': {
        title: '实施第二次初制动',
        body: `当前距停车标约${remaining.toFixed(0)} m、速度${s.speed.toFixed(1)} km/h。`,
        focus: '确认已查询列尾风压，主手柄回零，自阀再次置初制位形成约50 kPa减压，保持至列车停稳，不再缓解。',
      },
      'stop-alignment': {
        title: '侧窗对标与停车防溜',
        body: `列车已停稳，停车误差为${Math.abs(s.stopError || 0).toFixed(2)} m。停车位置以停车标与司机侧窗横向对齐为准。`,
        focus: '确认停稳后，自阀追加至减压100 kPa以上，单阀置全制动位。教学模式只讲解，不生成成绩。',
      },
    };
    const lesson = lessons[id];
    if (!lesson) return;
    s.teachingPause = { id, ...lesson };
    s.status = 'teaching-paused';
    this.log('teaching-pause', { lesson: id });
  }

  maybeCompleteSecure() {
    const s = this.state;
    if (!s.stopped || s.completed) return;
    if (s.mode === 'training' && !this.teachingSeen.has('stop-alignment')) return;
    const reduction = 600 - s.trainPipe;
    if (reduction >= 95 && s.independentBrake >= 5) this.complete();
  }

  complete() {
    const s = this.state;
    if (s.completed) return;
    s.completed = true;
    s.status = 'completed';
    this.log('attempt-complete', { secured: 600 - s.trainPipe >= 95 && s.independentBrake >= 5 });
    this.dispatchEvent(new CustomEvent('complete', { detail: s }));
  }

  updateLkjProtection() {
    const s = this.state;
    if (s.stopped) {
      s.lkjLevel = 'normal';
      return;
    }
    const excess = s.speed - s.lkjLimit;
    const previous = s.lkjLevel;
    if (excess >= 8) { s.lkjLevel = 'emergency'; s.lkjForcedBrake = 5; }
    else if (excess >= 5) { s.lkjLevel = 'service'; s.lkjForcedBrake = Math.max(s.lkjForcedBrake, 3); }
    else if (excess >= 3) s.lkjLevel = 'unload';
    else if (excess >= 2) s.lkjLevel = 'warning';
    else s.lkjLevel = 'normal';
    if (s.lkjLevel !== previous) {
      if (s.lkjLevel !== 'normal') s.lkjAcknowledged = false;
      this.log('lkj-level', { from: previous, to: s.lkjLevel, excess });
    }
  }

  trainingHint() {
    const s = this.state;
    if (s.mode !== 'training') return '考核模式仅记录操作，不显示答案';
    const remaining = remainingToTarget(s.distance);
    const exitRemaining = Math.max(0, SCENARIO.exitSignalDistance - s.distance);
    const applications = s.events.filter((event) => event.type === 'brake-application');
    const firstBrake = applications.find((event) => event.ordinal === 1);
    const secondBrake = applications.find((event) => event.ordinal === 2);
    const firstRelease = s.events.find((event) => event.type === 'brake-release' && event.ordinal === 1);
    const charged = s.events.some((event) => event.type === 'brake-pipe-charged');
    const tailQuery = s.events.find((event) => event.type === 'cir-action' && event.action?.type === 'tail-query');
    if (s.stopped) return 600 - s.trainPipe < 95 || s.independentBrake < 5
      ? '停车后：自阀追加至减压 100 kPa 以上，单阀置全制动位'
      : '停车防溜完成';
    if (!firstBrake && remaining > SCENARIO.standardBrakeDistance) return s.distance < SCENARIO.entryDistance
      ? '进站确认：查看LKJ、确认进站黄灯并呼唤，保持适当低牵引'
      : `进站后以LKJ为主：保持适当低牵引，距出站约 ${exitRemaining.toFixed(0)} m，准备在约 ${(SCENARIO.exitSignalDistance - SCENARIO.brakingPoint).toFixed(0)} m 初减`;
    if (!firstBrake) return `LKJ距出站约 ${exitRemaining.toFixed(0)} m：立即实施第一次约 50 kPa 初减压`;
    const brakingElapsed = Math.max(0, s.elapsed - (firstBrake?.elapsed || s.elapsed));
    if (!firstRelease && brakingElapsed < SCENARIO.tractionReleaseDelay) {
      return `保持低牵引，确认列车稳定降速；约 ${Math.ceil(SCENARIO.tractionReleaseDelay - brakingElapsed)} 秒后逐级退回主手柄`;
    }
    if (!firstRelease && s.traction > 0) return '列车已稳定降速：逐级退回牵引手柄至零位';
    if (!firstRelease && s.speed > SCENARIO.firstReleaseMaximumSpeed) return '保持第一次50 kPa初减，平稳降速至13–10 km/h缓解窗口';
    if (!firstRelease) return '速度已进入13–10 km/h窗口：自阀移至运转位充风，再将主手柄置牵引1级';
    if (!charged) return `自阀保持运转位充风，牵引1级维持约10 km/h；当前列尾 ${s.tailPipe.toFixed(0)} kPa`;
    if (!tailQuery && remaining <= SCENARIO.tailQueryPointRemaining) return '打开CIR按“风压查询”，确认列尾风压充足后再进行第二次制动';
    if (!secondBrake && remaining > SCENARIO.secondBrakeRemaining) return '以约10 km/h继续走行，距停车标20 m处准备第二次初制动';
    if (!secondBrake) return '距停车标约20 m：主手柄回零，自阀置初制位实施第二次约50 kPa减压';
    return '保持第二次初制动至停稳，停车标应与司机侧窗横向对齐';
  }

  emitChange() {
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
  }
}
