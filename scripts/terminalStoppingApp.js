import { CAB, PROJECT_ID, SCENARIO, TRACTION_MAX } from './terminalStoppingConfig.js?v=two-stage-2';
import { TerminalStoppingSimulation } from './terminalStoppingSimulation.js?v=two-stage-2';
import { TerminalStoppingAssessment } from './terminalStoppingAssessment.js?v=two-stage-2';
import { TerminalStoppingScene } from './terminalStoppingScene.js?v=two-stage-2';
import { LkjRuntime } from './lkjRuntime.js?v=two-stage-2';
import { CirRuntime } from './cirRuntime.js?v=two-stage-2';
import {
  clearCandidateDraft,
  createCandidateAttempt,
  formatAttemptTime,
  loadCandidateDraft,
  saveCandidateDraft,
  validateCandidate,
} from './terminalStoppingCandidate.js?v=two-stage-2';

const $ = (selector) => document.querySelector(selector);
const pct = (value, total) => `${value / total * 100}%`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const views = { front: 'HXD1C_front.png', left: 'HXD1C_left_full.png', right: 'HXD1C_right_full.png', rearLeft: 'HXD1C_left.png', rearRight: 'HXD1C_right.png' };
const brakeNames = ['运转位', '初制位', '常用Ⅱ', '常用Ⅲ', '常用Ⅳ', '紧急位'];
const autoBrakeFrames = [0, 1, 2, 9, 10, 11];
const signalFrames = { green: 7, greenYellow: 6, yellow: 5, redYellow: 1, red: 0 };

let simulation = new TerminalStoppingSimulation('training');
let assessment = new TerminalStoppingAssessment(simulation);
let routeScene = null;
let lkj = new LkjRuntime($('#lkj-dock'), simulation);
let cir = new CirRuntime(simulation);
let selectedView = 'front';
let lastFrame = performance.now();
let resultShown = false;
let activeDrag = null;
let suppressControlClickUntil = 0;
let routeLoadStartedAt = 0;
let audioContext = null;
let lastAlertLevel = 'normal';
let currentCandidate = loadCandidateDraft();
let currentAttempt = null;
let candidateAssetsReady = false;
let candidateCabReady = false;
let candidateLoadFailed = false;
let candidateEntryComplete = false;
let hornPointerId = null;
let lastTeachingPauseId = null;
const hornAudio = new Audio('./assets/audio/HXD1C-horn.wav');
hornAudio.preload = 'auto';
hornAudio.loop = true;
const overlay = $('#cab-overlay');
const elements = {};
const mobileLike = matchMedia('(pointer: coarse)').matches
  || matchMedia('(max-height:620px) and (orientation:landscape)').matches
  || navigator.maxTouchPoints > 0
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (mobileLike) document.body.classList.add('mobile-controls-enabled');

function syncVisualViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty('--visual-height', `${Math.round(viewport?.height || window.innerHeight)}px`);
  document.documentElement.style.setProperty('--visual-offset-top', `${Math.round(viewport?.offsetTop || 0)}px`);
}

function isPortraitMobile() {
  return mobileLike && matchMedia('(orientation: portrait)').matches;
}

function syncLandscapeGate() {
  const gate = $('#landscape-gate');
  if (!gate || !candidateEntryComplete) return;
  gate.hidden = !isPortraitMobile();
}

async function enterImmersive() {
  document.documentElement.classList.add('immersive');
  $('#landscape-gate').hidden = true;
  try {
    const root = document.documentElement;
    if (!document.fullscreenElement) {
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
    }
  } catch { /* iPhone Safari 等浏览器可能拒绝网页全屏，保留横屏提示作为回退。 */ }
  if (mobileLike) {
    try { await screen.orientation?.lock?.('landscape'); }
    catch { /* iOS 和部分内置浏览器不支持方向锁定。 */ }
  }
  setTimeout(() => {
    scrollTo(0, 1);
    syncVisualViewport();
    syncLandscapeGate();
    routeScene?.resize?.();
  }, 160);
}
syncVisualViewport();
window.visualViewport?.addEventListener('resize', syncVisualViewport);
window.visualViewport?.addEventListener('scroll', syncVisualViewport);

function makeSprite(id, image, x, y, width, height, columns, rows, label) {
  const element = document.createElement('div');
  element.className = `sprite ${id}`;
  element.setAttribute('aria-label', label);
  Object.assign(element.style, {
    left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height),
    backgroundImage: `url("./assets/archive-cabview/${image}")`, backgroundSize: `${columns * 100}% ${rows * 100}%`,
  });
  overlay.append(element);
  return element;
}

function makeBadge(id, label, x, y, width = 82) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'control-position-badge';
  element.innerHTML = `<b>${label}</b><span>—</span>`;
  Object.assign(element.style, { left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width) });
  overlay.append(element);
  return element;
}

function makePhysical(label, x, y, width, height, handler, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `physical-control ${className}`;
  element.setAttribute('aria-label', label);
  Object.assign(element.style, { left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height) });
  element.addEventListener('click', handler);
  overlay.append(element);
  return element;
}

function makeTouchTarget(id, x, y, width, height, label, handler) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `touch-target ${id}-touch-target`;
  element.setAttribute('aria-label', label);
  Object.assign(element.style, {
    left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height),
  });
  element.addEventListener('pointerdown', handler);
  overlay.append(element);
  return element;
}

function makeNeedle(id, image, x, y, width, height, pivot, start, end) {
  const element = document.createElement('img');
  element.className = 'original-game-needle';
  element.src = `./assets/archive-cabview/${image}`;
  element.alt = '';
  element.setAttribute('aria-hidden', 'true');
  element.dataset.start = start;
  element.dataset.end = end;
  Object.assign(element.style, {
    left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height),
    transformOrigin: `50% ${pivot / height * 100}%`,
  });
  overlay.append(element);
  elements[id] = element;
  return element;
}

function makeStateSprite(id, image, x, y, width, height, columns, rows) {
  const element = document.createElement('div');
  element.className = `state-sprite ${id}`;
  Object.assign(element.style, {
    left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height),
    backgroundImage: `url("./assets/archive-cabview/${image}")`, backgroundSize: `${columns * 100}% ${rows * 100}%`,
  });
  overlay.append(element);
  elements[id] = element;
  return element;
}

function makeBar(id, x, y, width, height, color) {
  const element = document.createElement('div');
  element.className = 'cab-gauge-bar';
  Object.assign(element.style, {
    left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height), backgroundColor: color,
  });
  overlay.append(element);
  elements[id] = element;
  return element;
}

function makeDigital(id, x, y, width, height, className = '') {
  const element = document.createElement('div');
  element.className = `cab-digital ${className}`;
  Object.assign(element.style, { left: pct(x, CAB.width), top: pct(y, CAB.height), width: pct(width, CAB.width), height: pct(height, CAB.height) });
  overlay.append(element);
  elements[id] = element;
  return element;
}

function setNeedle(element, value, maximum) {
  if (!element) return;
  const ratio = clamp(Number(value) / maximum, 0, 1);
  element.style.transform = `rotate(${Number(element.dataset.start) + (Number(element.dataset.end) - Number(element.dataset.start)) * ratio}deg)`;
}

function frame(element, index, columns, rows) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  element.style.backgroundPosition = `${columns === 1 ? 0 : column / (columns - 1) * 100}% ${rows === 1 ? 0 : row / (rows - 1) * 100}%`;
}

function tractionFrame(value) {
  return value > 0 ? Math.max(0, 7 - Math.round(Math.min(TRACTION_MAX, value) / TRACTION_MAX * 7)) : value === 0 ? 7 : Math.min(15, 7 + Math.min(8, Math.abs(value)));
}

function createCabControls() {
  overlay.replaceChildren();
  elements.auto = makeSprite('auto-brake', 'HXD1C_DZ.png', 35, 341, 45, 60, 4, 3, '上下拖动自动制动阀换位');
  elements.independent = makeSprite('independent-brake', 'HXD1C_XZ.png', 138, 341, 35, 60, 4, 3, '上下拖动单独制动阀；向右滑动并保持为单缓');
  elements.traction = makeSprite('traction', 'HXD1C_GL.png', 464, 345, 46, 81, 2, 8, '上下拖动牵引和电制动手柄');
  elements.direction = makeSprite('direction', 'HXD1C_HX.png', 530, 366, 60, 40, 3, 1, '点击切换换向手柄');
  elements.autoBadge = makeBadge('auto', '自阀', 20, 321, 80);
  elements.independentBadge = makeBadge('independent', '单阀', 116, 321, 78);
  elements.tractionBadge = makeBadge('traction', '牵引手柄', 438, 323, 86);
  elements.directionBadge = makeBadge('direction', '换向手柄', 521, 342, 88);
  makePhysical('放大LKJ监控装置', 210, 226, 101, 94, () => lkj.show(), 'lkj-hotspot');

  makeDigital('speedDigital', 229, 251, 20, 7, 'speed');
  makeDigital('limitDigital', 244, 251, 20, 7, 'limit');
  makeDigital('clockDigital', 230, 268, 45, 10, 'clock');
  makeNeedle('speedNeedle', 'HXD1C_SDZ.png', 493, 277, 3, 18, 2, 68, 300);
  makeNeedle('mainNeedle', 'HXD1C_red.png', 154, 253, 7, 21, 14, 230, 100);
  makeNeedle('pipeNeedle', 'HXD1C_black.png', 154, 253, 7, 21, 14, 230, 130);
  makeNeedle('equalizingNeedle', 'HXD1C_black.png', 162, 295, 7, 21, 14, 224, 136);
  makeNeedle('cylinderNeedle', 'HXD1C_red.png', 162, 295, 7, 21, 14, 230, 130);
  makeStateSprite('locomotive-signal', 'HXD1C_jx.png', 540, 0, 100, 162, 4, 2);
  makeStateSprite('pantograph-state', 'HXD1C_DG.png', 410, 295, 7, 8, 1, 2);
  makeBar('voltageBar', 351, 266, 4, 30, '#56e9aa');
  elements.currentBars = [362, 370, 381, 388].map((x, index) => makeBar(`currentBar${index}`, x, 266, 4, 30, '#66e9e8'));
  makePhysical('警惕复位', 386, 312, 32, 32, () => simulation.command('lkj-ack'), 'reset-hotspot');
  makePhysical('查看机车信号', 540, 0, 100, 162, () => lkj.show(), 'signal-hotspot');
  makePhysical('打开CIR机车综合无线通信设备', 606, 276, 34, 118, () => { lkj.close(); cir.open(); }, 'cir-hotspot');
  elements.horn = makePhysical('按住鸣笛', 577, 408, 37, 39, () => {}, 'horn-hotspot');
  elements.horn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    hornPointerId = event.pointerId;
    elements.horn.classList.add('pressed');
    simulation.command('horn-start');
    hornAudio.currentTime = 0;
    hornAudio.play().catch(() => {});
    try { elements.horn.setPointerCapture(event.pointerId); } catch { /* window listener releases the horn. */ }
  });

  const controls = [
    ['auto', elements.auto, 0, 5],
    ['independent', elements.independent, 0, 5],
    ['traction', elements.traction, -8, TRACTION_MAX],
  ];
  for (const [id, sprite, min, max] of controls) {
    const begin = (event) => {
      event.preventDefault();
      const stateKey = id === 'auto' ? 'autoBrake' : id === 'independent' ? 'independentBrake' : 'traction';
      const range = max - min;
      const step = id === 'traction'
        ? Math.max(18, Math.min(24, sprite.getBoundingClientRect().height / 4))
        : Math.max(10, sprite.getBoundingClientRect().height / range);
      activeDrag = {
        id, stateKey, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        startValue: simulation.state[stateKey], min, max, step, moved: false, sideReleaseEngaged: false,
      };
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* window listeners keep the drag active */ }
      event.currentTarget.addEventListener('pointerup', finishControlDrag, { once: true });
      event.currentTarget.addEventListener('pointercancel', finishControlDrag, { once: true });
      event.currentTarget.addEventListener('lostpointercapture', finishControlDrag, { once: true });
    };
    sprite.addEventListener('pointerdown', begin);
    const badge = id === 'auto' ? elements.autoBadge : id === 'independent' ? elements.independentBadge : elements.tractionBadge;
    badge.addEventListener('pointerdown', begin);
    badge.addEventListener('click', () => {
      if (activeDrag || performance.now() < suppressControlClickUntil) return;
      const key = id === 'auto' ? 'autoBrake' : id === 'independent' ? 'independentBrake' : 'traction';
      const next = simulation.state[key] >= max ? (id === 'traction' ? 0 : min) : simulation.state[key] + 1;
      simulation.command(id === 'auto' ? 'auto-brake' : id === 'independent' ? 'independent-brake' : 'traction', next);
    });
    if (id === 'auto') makeTouchTarget(id, 23, 326, 70, 91, '拖动自动制动阀', begin);
    if (id === 'independent') {
      makeTouchTarget(id, 122, 326, 35, 91, '上下拖动单阀；向右滑动并保持为单缓', begin);
      makeTouchTarget(id, 157, 380, 31, 37, '上下拖动单阀；向右滑动并保持为单缓', begin);
    }
    if (id === 'traction') makeTouchTarget(id, 447, 326, 80, 116, '拖动牵引和电制动手柄', begin);
  }
  const setDirection = () => simulation.command('direction', simulation.state.direction === 'F' ? 'N' : simulation.state.direction === 'N' ? 'R' : 'F');
  elements.direction.addEventListener('click', setDirection);
  elements.directionBadge.addEventListener('click', setDirection);
  makeTouchTarget('direction', 516, 350, 88, 70, '切换换向手柄', (event) => {
    event.preventDefault();
    setDirection();
  });
  elements.traction.addEventListener('dblclick', (event) => {
    event.preventDefault();
    simulation.command('traction', 0);
  });
}

window.addEventListener('pointermove', (event) => {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  event.preventDefault();
  const dx = event.clientX - activeDrag.startX;
  const dy = event.clientY - activeDrag.startY;
  if (activeDrag.sideReleaseEngaged) return;
  if (activeDrag.id === 'independent' && dx > 16 && Math.abs(dx) > Math.abs(dy) * 1.1) {
    if (!activeDrag.sideReleaseEngaged) {
      activeDrag.sideReleaseEngaged = true;
      activeDrag.moved = true;
      simulation.command('side-release', true);
    }
    return;
  }
  const change = Math.round((activeDrag.startY - event.clientY) / activeDrag.step);
  const value = clamp(activeDrag.startValue + change, activeDrag.min, activeDrag.max);
  if (value === simulation.state[activeDrag.stateKey]) return;
  activeDrag.moved = true;
  simulation.command(activeDrag.id === 'auto' ? 'auto-brake' : activeDrag.id === 'independent' ? 'independent-brake' : 'traction', value);
}, { passive: false });
function finishControlDrag(event) {
  if (!activeDrag) {
    if (simulation.state.sideRelease) simulation.command('side-release', false);
    return;
  }
  if (event?.pointerId !== undefined && activeDrag.pointerId !== event.pointerId) return;
  if (activeDrag.sideReleaseEngaged) simulation.command('side-release', false);
  if (activeDrag.moved) suppressControlClickUntil = performance.now() + 350;
  activeDrag = null;
}
document.addEventListener('pointerup', finishControlDrag, true);
document.addEventListener('pointercancel', finishControlDrag, true);
window.addEventListener('blur', () => finishControlDrag());
window.addEventListener('pagehide', () => finishControlDrag());

let routeWarmPromise = null;
function warmTerminalAssets() {
  if (routeWarmPromise) return routeWarmPromise;
  const urls = [
    new URL('../assets/msts-neiyi-corridor/neiyi-dashanpu-terminal-scene.json?v=two-stage-2', import.meta.url),
    new URL('../assets/msts-neiyi/neiyi-5635-trackdb-path-aligned.json?v=two-stage-2', import.meta.url),
    new URL('../assets/msts-neiyi-corridor/neiyi-dashanpu-terrain-native.json', import.meta.url),
  ];
  routeWarmPromise = Promise.all(urls.map((url) => fetch(url).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  }))).then(() => undefined);
  return routeWarmPromise;
}

async function chooseMode(mode) {
  const validation = validateCandidate(currentCandidate);
  if (!validation.valid) {
    openCandidateGate();
    return;
  }
  currentCandidate = validation.candidate;
  currentAttempt = createCandidateAttempt(currentCandidate);
  simulation = new TerminalStoppingSimulation(mode);
  assessment = new TerminalStoppingAssessment(simulation);
  lkj.simulation = simulation;
  lkj.setCandidate(currentAttempt);
  lkj.setRouteSampler(() => ({ grade: 0, curve: 0 }));
  lkj.page = 'main';
  lkj.menuIndex = 0;
  cir.setSimulation(simulation);
  routeScene?.dispose?.();
  const oldCanvas = $('#route-scene');
  const newCanvas = oldCanvas.cloneNode(false);
  oldCanvas.replaceWith(newCanvas);
  $('#route-loading-title').textContent = '正在加载终到站场';
  $('#route-loading-message').textContent = '正在读取原线路、站台和地形资源，加载完成后训练计时才会开始。';
  $('#route-loading-back').hidden = true;
  $('.loading-spinner').hidden = false;
  $('#route-loading').classList.add('open');
  $('#route-loading').setAttribute('aria-hidden', 'false');
  routeLoadStartedAt = performance.now();
  routeScene = new TerminalStoppingScene(newCanvas, SCENARIO, mode);
  simulation.addEventListener('change', render);
  simulation.addEventListener('complete', showResult);
  localStorage.setItem(`${PROJECT_ID}:last-mode`, mode);
  resultShown = false;
  lastTeachingPauseId = null;
  $('#mode-name').textContent = mode === 'training' ? '教学模式' : '考评模式';
  $('#training-guide').classList.toggle('hidden', mode !== 'training');
  $('#progress-panel-note').textContent = mode === 'training'
    ? '教学模式在关键节点冻结并讲解，不生成成绩。'
    : '考评模式只显示已记录项目，不提示下一步和阈值。';
  $('#mode-picker').classList.remove('open');
  $('#result-modal').classList.remove('open');
  lkj.close();
  cir.close();
  selectedView = 'front';
  selectView('front');
  try {
    await routeScene.loadPromise;
    $('#route-loading').classList.remove('open');
    $('#route-loading').setAttribute('aria-hidden', 'true');
    simulation.start();
    lastFrame = performance.now();
    render();
    routeScene.canvas.dataset.loadMilliseconds = String(Math.round(performance.now() - routeLoadStartedAt));
  } catch (error) {
    $('#status-message').textContent = `线路加载失败：${error.message}`;
    $('#route-loading-title').textContent = '线路加载失败';
    $('#route-loading-message').textContent = `${error.message}。请检查网络后返回重试。`;
    $('#route-loading-back').hidden = false;
    $('.loading-spinner').hidden = true;
    $('#route-loading').classList.add('open');
  }
}

function selectView(view) {
  selectedView = view;
  const cabView = $('#cab-view');
  const rearLookout = view === 'rearLeft' || view === 'rearRight';
  cabView.src = `./assets/archive-cabview/${views[view]}`;
  cabView.dataset.view = view;
  $('.stage').classList.toggle('rear-lookout-active', rearLookout);
  overlay.classList.toggle('hidden', view !== 'front');
  if (view !== 'front') cir.close();
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  routeScene?.setView(view);
}

function render() {
  const s = simulation.state;
  frame(elements.auto, autoBrakeFrames[s.autoBrake], 4, 3);
  frame(elements.independent, s.independentBrake, 4, 3);
  elements.independent.classList.toggle('side-release-active', s.sideRelease);
  frame(elements.traction, tractionFrame(s.traction), 2, 8);
  frame(elements.direction, s.direction === 'R' ? 0 : s.direction === 'N' ? 1 : 2, 3, 1);
  frame(elements['locomotive-signal'], signalFrames[s.signal?.aspect] ?? signalFrames.yellow, 4, 2);
  frame(elements['pantograph-state'], 1, 1, 2);
  setNeedle(elements.speedNeedle, s.speed, 158);
  setNeedle(elements.mainNeedle, s.mainReservoir, 1_600);
  setNeedle(elements.pipeNeedle, s.trainPipe, 1_000);
  setNeedle(elements.equalizingNeedle, s.equalizingReservoir, 1_600);
  setNeedle(elements.cylinderNeedle, s.locomotiveCylinder, 1_600);
  elements.speedDigital.textContent = s.speed < 10 ? s.speed.toFixed(1) : s.speed.toFixed(0);
  elements.limitDigital.textContent = s.lkjLimit.toFixed(0);
  elements.clockDigital.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  elements.voltageBar.style.transform = `scaleY(${clamp(s.netVoltage / 3800, .02, 1)})`;
  elements.currentBars.forEach((bar, index) => { bar.style.transform = `scaleY(${clamp((s.tractionCurrent - index * 18) / (index < 2 ? 1000 : 800), .02, 1)})`; });
  elements.autoBadge.querySelector('span').textContent = brakeNames[s.autoBrake];
  elements.independentBadge.querySelector('span').textContent = s.independentBrake ? `${s.independentBrake}级` : '缓解位';
  elements.tractionBadge.querySelector('span').textContent = s.traction > 0 ? `牵引 ${s.traction}级 / ${s.tractionTargetSpeed} km/h` : s.traction < 0 ? `电制 ${Math.abs(s.traction)}级` : '零位';
  elements.directionBadge.querySelector('span').textContent = s.direction === 'F' ? '前进位' : s.direction === 'R' ? '后退位' : '中立位';
  $('#phase-name').textContent = s.phase?.label || '进站对标';
  const remaining = SCENARIO.targetDistance - s.distance;
  const signalRemaining = Math.max(0, (s.signal?.distance || s.distance) - s.distance);
  const signalName = s.signal?.id === 'exit' ? '出站' : '进站';
  const levelText = { normal: '监控正常', warning: 'LKJ报警', unload: 'LKJ卸载', service: 'LKJ常用制动', emergency: 'LKJ紧急制动' }[s.lkjLevel];
  $('#status-message').textContent = s.status === 'teaching-paused'
    ? '运行已冻结 · 请阅读节点讲解'
    : s.stopped
    ? `停稳位置 ${formatError(s.stopError)} · 等待防溜操作`
    : `${levelText} · LKJ距${signalName} ${signalRemaining.toFixed(0)} m · 距标 ${Math.max(0, remaining).toFixed(0)} m`;
  $('#guide-speed').textContent = `${s.targetBand.target.toFixed(0)} km/h`;
  $('#guide-band').textContent = `${s.targetBand.minimum.toFixed(0)}–${s.targetBand.maximum.toFixed(0)} km/h`;
  $('#guide-signal-label').textContent = `LKJ距${signalName}`;
  $('#guide-signal-remaining').textContent = `${signalRemaining.toFixed(0)} m`;
  $('#guide-remaining').textContent = `距标 ${Math.max(0, remaining).toFixed(0)} m`;
  $('#guide-hint').textContent = simulation.trainingHint();
  const progress = assessment.progress(s);
  $('#progress-count').textContent = `${progress.done}/${progress.total}`;
  renderProgress(progress);
  updateMobileLabels(s);
  syncTeachingPause(s);
  if (cir.root.classList.contains('open')) cir.render();
  if (lkj.open) lkj.render();
  if (s.lkjLevel !== lastAlertLevel && s.lkjLevel !== 'normal') alertTone(s.lkjLevel);
  lastAlertLevel = s.lkjLevel;
}

function syncTeachingPause(s) {
  const modal = $('#teaching-pause');
  const lesson = s.mode === 'training' ? s.teachingPause : null;
  if (!lesson) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    return;
  }
  $('#teaching-title').textContent = lesson.title;
  $('#teaching-body').textContent = lesson.body;
  $('#teaching-focus').textContent = lesson.focus;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  if (lastTeachingPauseId !== lesson.id) {
    lkj.close();
    cir.close();
    if (lesson.id === 'stop-alignment') selectView('left');
    lastTeachingPauseId = lesson.id;
  }
}

function renderProgress(progress) {
  const names = ['LKJ查看记录', '信号呼唤记录', '第一次制动后逐级退牵', '第一次初制动', '13–10 km/h缓解', '列车管充风完成', '牵引1级低速走行', 'CIR列尾风压查询', '第二次初制动', '停车记录', '防溜记录', '任务完成'];
  $('#progress-list').innerHTML = names.map((name, index) => `<li class="${progress.checks[index] ? 'done' : 'pending'}">${name}</li>`).join('');
}

function updateMobileLabels(s) {
  $('[data-mobile-traction]')?.replaceChildren(elements.tractionBadge.querySelector('span').textContent);
  $('[data-mobile-auto]')?.replaceChildren(brakeNames[s.autoBrake]);
  $('[data-mobile-independent]')?.replaceChildren(s.independentBrake ? `${s.independentBrake}级` : '缓解位');
}

function formatError(error) {
  if (!Number.isFinite(error)) return '—';
  if (Math.abs(error) < .05) return '准确对标';
  return `${error > 0 ? '越标' : '欠标'} ${Math.abs(error).toFixed(2)} m`;
}

function showResult() {
  if (resultShown) return;
  resultShown = true;
  const teaching = simulation.state.mode === 'training';
  const result = teaching ? null : assessment.result();
  $('#result-name').textContent = currentAttempt?.name || '—';
  $('#result-student-id').textContent = currentAttempt?.studentId || '—';
  $('#result-started-at').textContent = formatAttemptTime(currentAttempt?.startedAt);
  $('#result-finished-at').textContent = formatAttemptTime(new Date());
  $('.result-card').classList.toggle('teaching-summary', teaching);
  if (teaching) {
    $('#result-title').textContent = '教学完成';
    $('#result-summary').textContent = `已完成第一次制动、13–10 km/h缓解、充风、列尾查询、10 km/h低速走行、第二次制动和侧窗对标讲解，用时 ${simulation.state.elapsed.toFixed(0)} s。本模式不生成成绩。`;
    $('#result-categories').replaceChildren();
    $('#result-curve').replaceChildren();
    $('#result-modal').classList.add('open');
    $('#result-modal').setAttribute('aria-hidden', 'false');
    return;
  }
  $('#result-score').textContent = result.score;
  $('#result-grade').textContent = result.summary;
  $('.result-score').classList.toggle('fail', !result.qualified);
  $('#result-title').textContent = '考评结果';
  $('#result-summary').textContent = `${formatError(result.stopError)}，用时 ${result.duration.toFixed(0)} s。${result.secured ? '停车后制动防溜完成。' : '停车后制动防溜未完成。'}${result.redline ? ' 本次触发安全红线。' : ''}`;
  $('#result-categories').innerHTML = result.categories.map((category) => `<div><span>${category.name}</span><b>${category.score}/${category.maximum}</b></div>`).join('');
  renderReplayCurve();
  $('#result-modal').classList.add('open');
  $('#result-modal').setAttribute('aria-hidden', 'false');
}

function renderReplayCurve() {
  const samples = simulation.state.samples;
  const width = 720;
  const height = 180;
  const usable = height - 24;
  const point = (sample, key) => `${clamp(sample.distance / SCENARIO.targetDistance, 0, 1) * width},${usable - clamp(sample[key], 0, 50) / 50 * usable + 8}`;
  const actual = samples.map((sample) => point(sample, 'speed')).join(' ');
  const target = samples.map((sample) => point(sample, 'target')).join(' ');
  const firstX = SCENARIO.firstBrakePoint / SCENARIO.targetDistance * width;
  const secondX = SCENARIO.secondBrakePoint / SCENARIO.targetDistance * width;
  $('#result-curve').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="速度距离复盘曲线"><path d="M0 ${usable + 8}H${width}M0 8V${usable + 8}"/><polyline class="curve-target" points="${target}"/><polyline class="curve-actual" points="${actual}"/><line class="curve-check" x1="${firstX}" x2="${firstX}" y1="8" y2="${usable + 8}"/><line class="curve-check" x1="${secondX}" x2="${secondX}" y1="8" y2="${usable + 8}"/></svg><div><span>绿色：实际速度</span><span>黄色：教学参考曲线</span><span>虚线：两次制动参照点</span></div>`;
}

function alertTone(level) {
  try {
    audioContext ||= new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = level === 'emergency' ? 880 : level === 'service' ? 720 : 560;
    gain.gain.setValueAtTime(.05, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .22);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + .23);
  } catch { /* 浏览器可能在首次手势前禁止音频。 */ }
}

function togglePanel(panel) {
  document.querySelectorAll('.side-panel').forEach((item) => {
    const open = item === panel && !item.classList.contains('open');
    item.classList.toggle('open', open);
    item.setAttribute('aria-hidden', String(!open));
  });
}

function animationFrame(now) {
  const dt = Math.min(.08, (now - lastFrame) / 1000);
  lastFrame = now;
  simulation.tick(dt);
  if (routeScene) {
    routeScene.update(simulation.state.distance, simulation.state.speed, selectedView);
    routeScene.render();
  }
  requestAnimationFrame(animationFrame);
}

function changeAuto(delta) {
  simulation.command('auto-brake', clamp(simulation.state.autoBrake + delta, 0, 5));
}

function openCandidateGate(clear = false) {
  if (clear) {
    clearCandidateDraft();
    currentCandidate = { name: '', studentId: '' };
  }
  $('#candidate-name').value = currentCandidate.name || '';
  $('#candidate-student-id').value = currentCandidate.studentId || '';
  $('#candidate-error').textContent = '';
  $('#candidate-name').removeAttribute('aria-invalid');
  $('#candidate-student-id').removeAttribute('aria-invalid');
  $('#candidate-gate').hidden = false;
  document.body.classList.add('candidate-entry-active');
  $('.training-app').inert = true;
  requestAnimationFrame(() => $('#candidate-name').focus());
}

function closeCandidateGate() {
  $('#candidate-gate').hidden = true;
  document.body.classList.remove('candidate-entry-active');
  $('.training-app').inert = false;
}

function updateCandidateGate() {
  const validation = validateCandidate({
    name: $('#candidate-name').value,
    studentId: $('#candidate-student-id').value,
  });
  const hasInput = Boolean($('#candidate-name').value || $('#candidate-student-id').value);
  $('#candidate-name').setAttribute('aria-invalid', String(hasInput && !validation.valid && validation.field === 'name'));
  $('#candidate-student-id').setAttribute('aria-invalid', String(hasInput && !validation.valid && validation.field === 'studentId'));
  $('#candidate-error').textContent = hasInput && !validation.valid ? validation.message : '';
  const ready = candidateAssetsReady && candidateCabReady && !candidateLoadFailed;
  const submit = $('#candidate-submit');
  submit.disabled = !ready || !validation.valid;
  submit.textContent = candidateLoadFailed ? '环境加载失败'
    : !ready ? '实训环境加载中'
      : validation.valid ? (mobileLike ? '横屏进入实训' : '进入实训') : '请填写姓名和学号';
  return validation;
}

function setupCandidateGate() {
  const cab = $('#cab-view');
  const cabReady = typeof cab.decode === 'function'
    ? cab.decode()
    : new Promise((resolve, reject) => {
      if (cab.complete && cab.naturalWidth) resolve();
      else {
        cab.addEventListener('load', resolve, { once: true });
        cab.addEventListener('error', reject, { once: true });
      }
    });
  cabReady.then(() => {
    candidateCabReady = true;
    updateCandidateGate();
  }).catch(() => {
    candidateLoadFailed = true;
    $('#candidate-load-status').textContent = '驾驶台图片加载失败，请刷新页面重试。';
    $('#candidate-load-status').dataset.state = 'error';
    updateCandidateGate();
  });
  warmTerminalAssets().then(() => {
    candidateAssetsReady = true;
    $('#candidate-load-status').textContent = '线路环境已加载，可以进入实训。';
    $('#candidate-load-status').dataset.state = 'ready';
    updateCandidateGate();
  }).catch((error) => {
    candidateLoadFailed = true;
    $('#candidate-load-status').textContent = `线路环境加载失败：${error.message}`;
    $('#candidate-load-status').dataset.state = 'error';
    updateCandidateGate();
  });
  for (const input of [$('#candidate-name'), $('#candidate-student-id')]) {
    input.addEventListener('input', updateCandidateGate);
    input.addEventListener('focus', syncVisualViewport);
  }
  updateCandidateGate();
}

createCabControls();
$('#candidate-name').value = currentCandidate.name;
$('#candidate-student-id').value = currentCandidate.studentId;
setupCandidateGate();
$('#candidate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!candidateAssetsReady || !candidateCabReady || candidateLoadFailed) return;
  const validation = updateCandidateGate();
  if (!validation.valid) {
    $(`#candidate-${validation.field === 'studentId' ? 'student-id' : 'name'}`).focus();
    return;
  }
  currentCandidate = saveCandidateDraft(validation.candidate);
  candidateEntryComplete = true;
  closeCandidateGate();
  syncVisualViewport();
  await enterImmersive();
});
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => chooseMode(button.dataset.mode)));
$('#callout').addEventListener('click', () => simulation.command('callout'));
$('#teaching-continue').addEventListener('click', () => {
  const returnToCab = simulation.state.teachingPause?.id === 'stop-alignment';
  simulation.command('teaching-continue');
  if (returnToCab) selectView('front');
});
$('#progress-toggle').addEventListener('click', () => togglePanel($('#progress-panel')));
$('#rules-toggle').addEventListener('click', () => togglePanel($('#rules-panel')));
$('#mobile-operations-toggle').addEventListener('click', () => {
  const panel = $('#mobile-operations');
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', String(!open));
  $('#mobile-operations-toggle').setAttribute('aria-expanded', String(open));
});
$('[data-mobile-close]').addEventListener('click', () => $('#mobile-operations-toggle').click());
document.querySelectorAll('[data-mobile-command]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.mobileCommand;
  const s = simulation.state;
  if (action === 'traction-down') simulation.command('traction', Math.max(-8, s.traction - 1));
  else if (action === 'traction-zero') simulation.command('traction', 0);
  else if (action === 'traction-up') simulation.command('traction', Math.min(TRACTION_MAX, s.traction + 1));
  else if (action === 'auto-down') simulation.command('auto-brake', Math.max(0, s.autoBrake - 1));
  else if (action === 'auto-up') simulation.command('auto-brake', Math.min(5, s.autoBrake + 1));
  else if (action === 'independent-down') simulation.command('independent-brake', Math.max(0, s.independentBrake - 1));
  else if (action === 'independent-up') simulation.command('independent-brake', Math.min(5, s.independentBrake + 1));
  else if (action === 'lkj') {
    $('#mobile-operations-toggle').click();
    cir.close();
    lkj.show();
  } else if (action === 'cir') {
    $('#mobile-operations-toggle').click();
    lkj.close();
    cir.open();
  }
}));
$('#view-toggle').addEventListener('click', () => $('#view-menu').classList.toggle('open'));
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { selectView(button.dataset.view); $('#view-menu').classList.remove('open'); }));
document.querySelectorAll('[data-close-panel]').forEach((button) => button.addEventListener('click', () => togglePanel(button.closest('.side-panel'))));
$('#fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (mobileLike) await enterImmersive();
    else await $('#stage').requestFullscreen();
  } catch { /* 全屏权限由浏览器决定。 */ }
});
$('#enter-landscape').addEventListener('click', enterImmersive);
$('#retry').addEventListener('click', () => chooseMode(simulation.state.mode));
$('#choose-mode').addEventListener('click', () => { $('#result-modal').classList.remove('open'); $('#mode-picker').classList.add('open'); });
$('#change-candidate').addEventListener('click', () => {
  clearCandidateDraft();
  location.reload();
});
$('#route-loading-back').addEventListener('click', () => {
  $('#route-loading').classList.remove('open');
  $('#route-loading').setAttribute('aria-hidden', 'true');
  $('#mode-picker').classList.add('open');
});
window.addEventListener('keydown', (event) => {
  if (!$('#candidate-gate').hidden || $('#mode-picker').classList.contains('open')) return;
  if (event.key === 'Escape') {
    document.querySelectorAll('.side-panel').forEach((panel) => panel.classList.remove('open'));
    $('#view-menu').classList.remove('open');
    cir.close();
    lkj.close();
  }
  if (event.key === '0') simulation.command('traction', 0);
  if (event.key === 'ArrowUp') changeAuto(1);
  if (event.key === 'ArrowDown') changeAuto(-1);
});

function stopHorn(event) {
  if (hornPointerId === null || (event?.pointerId != null && event.pointerId !== hornPointerId)) return;
  hornPointerId = null;
  hornAudio.pause();
  hornAudio.currentTime = 0;
  elements.horn?.classList.remove('pressed');
  simulation.command('horn-stop');
}
window.addEventListener('pointerup', stopHorn);
window.addEventListener('pointercancel', stopHorn);
window.addEventListener('orientationchange', () => {
  syncVisualViewport();
  setTimeout(() => { syncVisualViewport(); syncLandscapeGate(); routeScene?.resize?.(); }, 180);
});
window.addEventListener('fullscreenchange', () => {
  syncVisualViewport();
  if (!document.fullscreenElement && !isPortraitMobile()) document.documentElement.classList.remove('immersive');
  syncLandscapeGate();
  routeScene?.resize?.();
});

window.__terminalStopping = {
  get simulation() { return simulation; },
  get assessment() { return assessment; },
  get routeScene() { return routeScene; },
  get candidate() { return currentAttempt; },
  chooseMode,
};
render();
requestAnimationFrame(animationFrame);
