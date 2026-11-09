import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  PROJECT_ID,
  SCENARIO,
  TRACTION_MAX,
  brakingDistanceForSpeed,
  lkjCurvesAt,
  targetCurveSpeed,
} from '../scripts/terminalStoppingConfig.js';
import { TerminalStoppingSimulation } from '../scripts/terminalStoppingSimulation.js';
import { TerminalStoppingAssessment } from '../scripts/terminalStoppingAssessment.js';

function runStandard({ query = true, queryEarly = false, releaseSpeed = 12, secondBrake = true } = {}) {
  const simulation = new TerminalStoppingSimulation('assessment');
  simulation.start();
  simulation.command('lkj-open');
  simulation.command('callout');
  let firstApplied = false;
  let tractionReleased = false;
  let firstReleased = false;
  let queried = false;
  let secondApplied = false;
  let secured = false;
  for (let index = 0; index < 60_000 && !simulation.state.completed; index += 1) {
    const state = simulation.state;
    const remaining = SCENARIO.targetDistance - state.distance;
    if (!firstApplied && remaining <= SCENARIO.standardBrakeDistance) {
      simulation.command('auto-brake', 1);
      firstApplied = true;
    }
    const firstBrake = state.events.find((event) => event.type === 'brake-application' && event.ordinal === 1);
    if (firstBrake && !tractionReleased && state.elapsed - firstBrake.elapsed >= SCENARIO.tractionReleaseDelay) {
      for (const notch of [3, 2, 1]) simulation.command('traction', notch);
      tractionReleased = true;
    }
    if (queryEarly && firstBrake && !queried && state.elapsed - firstBrake.elapsed >= 8) {
      simulation.command('cir-action', { type: 'tail-query', pressure: Math.round(state.tailPipe) });
      queried = true;
    }
    if (firstApplied && !firstReleased && state.speed <= releaseSpeed) {
      simulation.command('auto-brake', 0);
      firstReleased = true;
    }
    const charged = state.trainPipe >= 595
      && state.tailPipe >= SCENARIO.tailQueryMinimumPressure
      && Math.abs(state.trainPipe - state.tailPipe) <= SCENARIO.tailQueryMaximumDifference;
    if (query && !queryEarly && firstReleased && charged && !queried) {
      simulation.command('cir-action', { type: 'tail-query', pressure: Math.round(state.tailPipe) });
      queried = true;
    }
    if (secondBrake && firstReleased && !secondApplied && remaining <= SCENARIO.secondBrakeRemaining) {
      simulation.command('traction', 0);
      simulation.command('auto-brake', 1);
      secondApplied = true;
    }
    if (state.stopped && !secured) {
      simulation.command('auto-brake', 3);
      simulation.command('independent-brake', 5);
      secured = true;
    }
    simulation.tick(.05);
  }
  return simulation;
}

test('两段制动教学基线与LKJ地面距离换算正确', () => {
  assert.equal(SCENARIO.standardBrakeDistance, 400);
  assert.equal(SCENARIO.oneStageBrakeDistance, 280);
  assert.equal(SCENARIO.firstBrakeExtraDistance, 120);
  assert.equal(SCENARIO.targetDistance - SCENARIO.firstBrakePoint, 400);
  assert.equal(SCENARIO.exitSignalDistance - SCENARIO.firstBrakePoint, 520);
  assert.equal(SCENARIO.exitSignalDistance - SCENARIO.targetDistance, 120);
  assert.equal(SCENARIO.targetDistance - SCENARIO.secondBrakePoint, 20);
  assert.equal(SCENARIO.firstReleaseMinimumSpeed, 10);
  assert.equal(SCENARIO.firstReleaseMaximumSpeed, 13);
  assert.equal(brakingDistanceForSpeed(40), 400);
  assert.equal(brakingDistanceForSpeed(41), 420);
  assert.equal(targetCurveSpeed(20), 10);
});

test('标准两段制动流程在0.5米内停车并取得满分', () => {
  const simulation = runStandard();
  const result = new TerminalStoppingAssessment(simulation).result();
  assert.equal(simulation.state.completed, true);
  assert.ok(Math.abs(simulation.state.stopError) <= .5, `stop error ${simulation.state.stopError}`);
  assert.equal(result.score, 100);
  assert.equal(result.qualified, true);
  assert.equal(result.redline, false);
  assert.ok(result.checkpoints.firstBrakeRemaining >= 380 && result.checkpoints.firstBrakeRemaining <= 420);
  assert.ok(result.checkpoints.firstReleaseSpeed >= 10 && result.checkpoints.firstReleaseSpeed <= 13);
  assert.ok(result.checkpoints.tailQueryPressure >= 590);
  assert.ok(result.checkpoints.secondBrakeSpeed >= 9 && result.checkpoints.secondBrakeSpeed <= 11);
  assert.ok(result.checkpoints.secondBrakeRemaining >= 17 && result.checkpoints.secondBrakeRemaining <= 23);
});

test('标准流程形成两次独立初制动且中间完成缓解充风', () => {
  const simulation = runStandard();
  const events = simulation.state.events;
  const applications = events.filter((event) => event.type === 'brake-application');
  assert.equal(applications.length, 2);
  assert.deepEqual(applications.map((event) => event.value), [1, 1]);
  assert.ok(events.some((event) => event.type === 'brake-release' && event.ordinal === 1));
  assert.ok(events.some((event) => event.type === 'brake-pipe-charged'));
  assert.ok(events.some((event) => event.type === 'traction' && event.value === 1));
});

test('教学模式按实操顺序退至1级、10公里缓解、低速走行和列尾查询均记入进度', () => {
  const simulation = new TerminalStoppingSimulation('training');
  simulation.start();
  simulation.command('teaching-continue');
  simulation.command('lkj-open');
  simulation.command('callout');
  simulation.state.distance = SCENARIO.firstBrakePoint;
  simulation.command('auto-brake', 1);
  simulation.command('side-release', true);
  simulation.command('side-release', false);
  const firstBrake = simulation.state.events.find((event) => event.type === 'brake-application');
  let tractionReduced = false;
  let released = false;
  let minimumSpeedBeforeCharge = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 20_000; index += 1) {
    if (simulation.state.status === 'teaching-paused') simulation.command('teaching-continue');
    if (!tractionReduced && simulation.state.elapsed - firstBrake.elapsed >= SCENARIO.tractionReleaseDelay) {
      simulation.command('traction-drag', 1);
      tractionReduced = true;
    }
    if (tractionReduced && !released && simulation.state.speed <= 10.04) {
      simulation.command('auto-brake', 0);
      released = true;
    }
    if (released) minimumSpeedBeforeCharge = Math.min(minimumSpeedBeforeCharge, simulation.state.speed);
    const charged = simulation.state.events.find((event) => event.type === 'brake-pipe-charged');
    if (charged) {
      simulation.command('cir-action', { type: 'tail-query', pressure: Math.round(simulation.state.tailPipe) });
      break;
    }
    simulation.tick(.05);
  }
  const progress = new TerminalStoppingAssessment(simulation).progress();
  assert.deepEqual(progress.checks.slice(2, 8), [true, true, true, true, true, true]);
  assert.ok(minimumSpeedBeforeCharge >= 9, `minimum speed ${minimumSpeedBeforeCharge}`);
  const reductions = simulation.state.events.filter((event) => event.type === 'traction').map((event) => event.value);
  assert.deepEqual(reductions.slice(-3), [3, 2, 1]);
});

test('未查询列尾风压不得评为合格', () => {
  const simulation = runStandard({ query: false });
  const result = new TerminalStoppingAssessment(simulation).result();
  assert.equal(result.qualified, false);
  assert.ok(result.categories.find((item) => item.name === '列尾查询与第二次制动').score < 20);
});

test('充风完成前的列尾查询不计为有效查询', () => {
  const simulation = runStandard({ queryEarly: true });
  const result = new TerminalStoppingAssessment(simulation).result();
  assert.equal(result.qualified, false);
  assert.ok(result.checkpoints.tailQueryPressure < SCENARIO.tailQueryMinimumPressure);
});

test('在13公里以上提前缓解会扣除缓解充风得分', () => {
  const simulation = runStandard({ releaseSpeed: 15 });
  const result = new TerminalStoppingAssessment(simulation).result();
  assert.ok(result.categories.find((item) => item.name === '缓解充风与低速走行').score < 20);
});

test('教学模式启动即冻结讲解且考评模式不冻结', () => {
  const teaching = new TerminalStoppingSimulation('training');
  teaching.start();
  assert.equal(teaching.state.status, 'teaching-paused');
  assert.equal(teaching.state.teachingPause?.id, 'brake-strength');
  const assessment = new TerminalStoppingSimulation('assessment');
  assessment.start();
  assert.equal(assessment.state.status, 'running');
  assert.equal(assessment.state.teachingPause, null);
});

test('教学结束前必须完成末节点讲解和停车防溜', () => {
  const teaching = new TerminalStoppingSimulation('training');
  teaching.start();
  teaching.command('teaching-continue');
  teaching.state.stopped = true;
  teaching.state.speed = 0;
  teaching.state.stopError = 0;
  teaching.state.status = 'running';
  teaching.pauseTeaching('stop-alignment');
  teaching.command('auto-brake', 3);
  teaching.command('independent-brake', 5);
  for (let index = 0; index < 300; index += 1) teaching.tick(.05);
  assert.equal(teaching.state.completed, false);
  teaching.command('teaching-continue');
  for (let index = 0; index < 300 && !teaching.state.completed; index += 1) teaching.tick(.05);
  assert.equal(teaching.state.completed, true);
});

test('牵引4级给定40公里且达到给定速度后不继续加速', () => {
  const simulation = new TerminalStoppingSimulation('assessment');
  simulation.start();
  let maximumSpeed = simulation.state.speed;
  for (let index = 0; index < 1_200; index += 1) {
    simulation.tick(.05);
    maximumSpeed = Math.max(maximumSpeed, simulation.state.speed);
  }
  assert.equal(TRACTION_MAX, 12);
  assert.ok(maximumSpeed <= 40.05, `maximum speed ${maximumSpeed}`);
});

test('LKJ在进站信号机处切换45公里站内限速', () => {
  assert.equal(lkjCurvesAt(SCENARIO.entryDistance - .1).lineLimit, 80);
  assert.equal(lkjCurvesAt(SCENARIO.entryDistance).lineLimit, 45);
  assert.equal(lkjCurvesAt(SCENARIO.targetDistance).lineLimit, 45);
});

test('项目标识与页面标题独立于一段制动项目', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(PROJECT_ID, 'hxd1c-two-stage-terminal-stopping-v1');
  assert.match(html, /两段制动对标停车虚拟实训/);
  assert.match(html, /过程记录 <b id="progress-count">0\/12<\/b>/);
  assert.match(html, /CIR中查询列尾风压/);
});

test('CIR预置列尾连接并将风压查询写入评分事件', () => {
  const source = readFileSync(new URL('../scripts/cirRuntime.js', import.meta.url), 'utf8');
  assert.match(source, /device\.mmiinfo\[1\] \|\|= '9123456'/);
  assert.match(source, /tailState\.textContent = '已连接 123456'/);
  assert.match(source, /type: 'tail-query'/);
  assert.match(source, /pressure: this\.query/);
});

test('终到场景继续使用连续站台和对应地面信号机', () => {
  const sceneUrl = new URL('../assets/msts-neiyi-corridor/neiyi-dashanpu-terminal-scene.json', import.meta.url);
  const scene = JSON.parse(readFileSync(sceneUrl, 'utf8'));
  const platforms = scene.instances.filter((item) => item.uid >= 906951 && item.uid <= 906955);
  assert.equal(platforms.length, 5);
  assert.equal(scene.instances.find((item) => item.uid === 51755)?.shape, 'jinzhan.s');
  assert.equal(scene.instances.find((item) => item.uid === 51674)?.shape, 'chuzhan-halfauto.s');
  assert.ok(statSync(sceneUrl).size < 1_700_000);
});

test('终到裁剪场景引用的全部纹理均可发布', () => {
  const scene = JSON.parse(readFileSync(new URL('../assets/msts-neiyi-corridor/neiyi-dashanpu-terminal-scene.json', import.meta.url), 'utf8'));
  const textureRoot = fileURLToPath(new URL('../assets/msts-neiyi-corridor/textures/', import.meta.url));
  const aliases = { 'acleanttrack1.png': 'ACleanTrack1.png', 'acleanttrack2.png': 'ACleanTrack2.png', 'acleantrack1.png': 'ACleanTrack1.png', 'acleantrack2.png': 'ACleanTrack2.png', 'sign.png': 'Sign.png' };
  const textures = [...new Set(Object.values(scene.shapes).flatMap((shape) => (shape.materials || []).map((material) => material.texture).filter(Boolean)))];
  const missing = textures.filter((name) => !existsSync(join(textureRoot, aliases[name.toLowerCase()] || name)));
  assert.deepEqual(missing, []);
});

test('手机端、LKJ、操作台和后部瞭望保留已验收逻辑', () => {
  const app = readFileSync(new URL('../scripts/terminalStoppingApp.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../styles/terminal-stopping.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(app, /autoBrakeFrames = \[0, 1, 2, 9, 10, 11\]/);
  assert.match(app, /await routeScene\.loadPromise/);
  assert.match(app, /classList\.toggle\('rear-lookout-active', rearLookout\)/);
  assert.match(css, /\.stage\.rear-lookout-active \.cab-view \{ display: none; \}/);
  assert.match(html, /data-mobile-command="cir"/);
  assert.match(html, /左后部瞭望/);
});
