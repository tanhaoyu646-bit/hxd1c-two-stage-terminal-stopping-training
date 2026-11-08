import {
  LKJ_KEYS,
  absoluteKilometerAt,
  lkjControlLimit,
  routeFacilitiesForScenario,
} from './terminalStoppingConfig.js?v=two-stage-2';

const pct = (value, total) => `${value / total * 100}%`;
const fmt = (value, digits = 0) => Number(value || 0).toFixed(digits);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const MENU = Object.freeze([
  ['current', '当前揭示', '1'],
  ['condition', '工况显示', '2'],
  ['all', '全部揭示', '3'],
  ['equipment', '设备状态', '4'],
  ['maintenance', '检修参数', '5'],
  ['parameters', '设定参数', '6'],
  ['return', '返回监控', '0'],
]);

const CHART = Object.freeze({ left: 50, position: 190, right: 752, top: 60, bottom: 390, speedMaximum: 140, speedTick: 20, pixelsPerMeter: 0.14 });

export class LkjRuntime {
  constructor(root, simulation) {
    this.root = root;
    this.simulation = simulation;
    this.screen = root.querySelector('.lkj-screen');
    this.page = 'main';
    this.menuIndex = 0;
    this.notice = '';
    this.open = false;
    this.conditionVisible = false;
    this.candidate = Object.freeze({ name: '', studentId: '' });
    this.routeSampler = () => ({ grade: 0, curve: 0 });
    this.profileCache = null;
    this.buildKeys();
    root.querySelector('[data-lkj-close]').addEventListener('click', () => this.close());
  }

  setCandidate(candidate = {}) {
    this.candidate = Object.freeze({ name: String(candidate.name || ''), studentId: String(candidate.studentId || '') });
  }

  setRouteSampler(sampler) {
    this.routeSampler = typeof sampler === 'function' ? sampler : () => ({ grade: 0, curve: 0 });
    this.profileCache = null;
  }

  buildKeys() {
    const keypad = this.root.querySelector('.lkj-keypad');
    keypad.replaceChildren();
    for (const [id, label, x, y, width, height] of LKJ_KEYS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = id;
      button.setAttribute('aria-label', label);
      Object.assign(button.style, { left: pct(x, 800), top: pct(y, 615), width: pct(width, 800), height: pct(height, 615) });
      button.addEventListener('pointerdown', () => button.classList.add('pressed'));
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => button.addEventListener(name, () => button.classList.remove('pressed')));
      button.addEventListener('click', () => this.handleKey(id));
      keypad.append(button);
    }
  }

  show() {
    this.open = true;
    this.root.classList.add('open');
    this.root.setAttribute('aria-hidden', 'false');
    this.simulation.command('lkj-open');
    this.render();
  }

  close() {
    this.open = false;
    this.root.classList.remove('open');
    this.root.setAttribute('aria-hidden', 'true');
  }

  openMenuChoice(id) {
    if (id === 'return') {
      this.page = 'main';
      return;
    }
    if (id === 'condition') {
      this.conditionVisible = true;
      this.page = 'main';
      return;
    }
    this.page = id;
  }

  handleKey(id) {
    const s = this.simulation.state;
    if (id === 'alarm') {
      this.simulation.command('lkj-ack');
      this.flash('报警已确认');
      return;
    }
    if (id === 'relief') {
      this.simulation.command('lkj-relief');
      this.flash(s.lkjForcedBrake ? '未满足缓解条件' : '制动指令已缓解');
      return;
    }
    if (id === 'query') { this.page = 'menu'; this.menuIndex = 0; this.render(); return; }
    if (id === 'setting') { this.page = 'parameters'; this.render(); return; }
    if (id === 'dump') {
      if (s.speed > 0.5) this.flash('运行中禁止文件转储');
      else { this.page = 'records'; this.render(); }
      return;
    }
    if (this.page === 'menu') {
      if (id === 'up') this.menuIndex = (this.menuIndex - 1 + MENU.length) % MENU.length;
      else if (id === 'down') this.menuIndex = (this.menuIndex + 1) % MENU.length;
      else if (id === 'confirm' || id === 'right') this.openMenuChoice(MENU[this.menuIndex][0]);
      else if (id === 'left' || id === 'relief') this.page = 'main';
      else if (id.startsWith('digit-')) {
        const key = id.slice(6);
        const choice = MENU.find((item) => item[2] === key);
        if (choice) this.openMenuChoice(choice[0]);
      }
      this.render();
      return;
    }
    if (this.page !== 'main') {
      if ((id === 'up' || id === 'down') && this.page === 'records') {
        this.recordOffset = Math.max(0, Math.min(s.events.length - 1, (this.recordOffset || 0) + (id === 'up' ? 1 : -1)));
      } else if (id === 'left') this.page = 'menu';
      else if (id === 'confirm' || id === 'relief') this.page = 'main';
      this.render();
      return;
    }
    if (this.conditionVisible && id === 'confirm') {
      this.conditionVisible = false;
      this.render();
      return;
    }
    if (id === 'digit-3') {
      this.positionArmUntil = performance.now() + 5000;
      this.flash('车位调整：5秒内按向前或向后');
      return;
    }
    if ((id === 'digit-1' || id === 'digit-6') && performance.now() <= (this.positionArmUntil || 0)) {
      this.simulation.command('lkj-position-correct', id === 'digit-1' ? 'forward' : 'backward');
      this.positionArmUntil = 0;
      this.flash(id === 'digit-1' ? '车位向前校正已记录' : '车位向后校正已记录');
      return;
    }
    if (id === 'digit-8') { this.simulation.command('lkj-position-correct', 'auto'); this.flash('自动校正已记录'); return; }
    if (id === 'digit-7') { this.simulation.command('lkj-start-align'); this.flash('开车对标已记录'); return; }
    if (id === 'digit-5') { this.simulation.command('lkj-mark'); this.flash('定标记录完成'); return; }
    if (id === 'digit-0') { this.simulation.command('lkj-patrol'); this.flash('巡检记录完成'); return; }
    if (id === 'unlock') { this.flash('当前无解锁条件'); return; }
    if (id === 'up' || id === 'down') { this.flash(id === 'up' ? '显示亮度增加' : '显示亮度降低'); return; }
    if (id === 'left' || id === 'right') { this.flash(id === 'left' ? '提示音量降低' : '提示音量增加'); return; }
    if (id.startsWith('digit-')) { this.flash('当前状态下该快捷键无效'); return; }
    this.flash('当前状态下该键无效');
  }

  flash(message) {
    this.notice = message;
    this.render();
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = ''; this.render(); }, 1600);
  }

  render() {
    const s = this.simulation.state;
    const scenario = this.simulation.scenario;
    let body = '';
    if (this.page === 'menu') body = this.menuPage();
    else if (this.page === 'equipment') body = this.detailPage('设备状态', [
      ['监控主机A/B', '双机正常'], ['速度通道1/2/3', `${fmt(s.speed)} / ${fmt(s.speed)} / ${fmt(s.speed)} km/h`],
      ['压力通道', `${fmt(s.trainPipe)} kPa`], ['机车信号', this.aspectLabel(s.signal.aspect)], ['记录单元', '正常'], ['制动接口', s.lkjForcedBrake ? '指令输出中' : '正常'],
    ]);
    else if (this.page === 'maintenance') body = this.detailPage('检修参数', [
      ['装置号', 'LKJ2000-22601'], ['机车型号', scenario.lkj.locomotive], ['机车号', 'HXD1C-模拟'], ['轮径', '1250 mm'],
      ['制动机', 'CCBⅡ'], ['最大总重', '1200 t'], ['最大计长', '60.0'], ['双针表量程', '1000 kPa'],
    ]);
    else if (this.page === 'parameters') body = this.parameterPage(scenario);
    else if (this.page === 'current' || this.page === 'all') body = this.revealPage(this.page === 'current', s, scenario);
    else if (this.page === 'records') body = this.recordsPage(s);
    else body = this.mainPage(s, scenario);

    this.screen.innerHTML = `${this.topLayer(s, scenario)}${body}${this.statusLayer(s, scenario)}${this.notice ? `<div class="lkj-notice">${escapeHtml(this.notice)}</div>` : ''}`;
  }

  topLayer(s, scenario) {
    const now = new Date();
    const targetDistance = Math.max(0, (s.signal.distance || s.distance) - s.distance);
    const signalLabel = s.signal.id === 'clear' ? '通过' : s.signal.label.replace(/信号机/g, '');
    const kilometer = absoluteKilometerAt(scenario, s.distance);
    const grade = s.signal.aspect === 'green' ? 'LC' : ['green-yellow', 'greenYellow'].includes(s.signal.aspect) ? 'SD1' : 'SD2';
    return `<div class="lkj-native-aspect ${s.signal.aspect}" aria-label="${escapeHtml(this.aspectLabel(s.signal.aspect))}"></div>
      <div class="lkj-speed-grade"><span class="${grade === 'LC' ? 'active' : ''}">LC</span><span class="${grade === 'SD3' ? 'active' : ''}">SD3</span><span class="${grade === 'SD2' ? 'active' : ''}">SD2</span><span class="${grade === 'SD1' ? 'active' : ''}">SD1</span></div>
      <b class="lkj-native-speed">${fmt(s.speed)}</b><b class="lkj-native-limit">${fmt(s.lkjLimit)}</b><b class="lkj-native-distance">${fmt(targetDistance)}</b>
      <b class="lkj-native-station">${escapeHtml(signalLabel)}</b><b class="lkj-native-km">${fmt(kilometer, 3)}</b>
      <time class="lkj-native-date">${now.toLocaleDateString('zh-CN').replaceAll('/', '-')}</time><time class="lkj-native-time">${now.toLocaleTimeString('zh-CN', { hour12: false })}</time>`;
  }

  statusLayer(s, scenario) {
    const active = new Set([
      s.lkjLevel === 'emergency' ? 'emergency' : '', s.lkjLevel === 'service' ? 'service' : '', s.lkjLevel === 'unload' ? 'unload' : '',
      'authority', scenario.lkj.trainKind.startsWith('客') ? 'passenger' : 'freight', 'machine',
    ]);
    const rows = [
      ['fault', '故障'], ['degrade', '降级'], ['emergency', '紧急'], ['service', '常用'], ['unload', '卸载'], ['unlock', '解锁'],
      ['start', '开车'], ['shunt', '调车'], ['authority', '有权'], ['passenger', scenario.lkj.trainKind], ['card', 'IC卡'], ['machine', 'A机'], ['branch', '支线'], ['siding', '侧线'], ['diagnosis', '诊断'],
    ];
    return `<div class="lkj-state-lamps">${rows.map(([id, label]) => `<span class="${active.has(id) ? `active ${id}` : ''}">${escapeHtml(label)}</span>`).join('')}</div>`;
  }

  menuPage() {
    return `<section class="lkj-native-dialog lkj-query-dialog"><header>查询选择</header><ol>${MENU.map(([id, label, key], index) => `<li class="${index === this.menuIndex ? 'selected' : ''}" data-page="${id}"><b>${key}</b><span>${label}</span></li>`).join('')}</ol><footer>↑↓选择　确认进入　缓解/←返回</footer></section>`;
  }

  parameterPage(scenario) {
    const lkj = scenario.lkj;
    const rows = [
      ['司机号', this.candidate.studentId || '未登记'], ['副司机号', '000000'], ['监控交路', lkj.sectionCode], ['车站号', '226'],
      ['车次种类', '5'], ['车次编号', lkj.trainNumber], ['列车种类', lkj.trainKind], ['车速等级', `${lkj.speedGrade} km/h`],
      ['总重', `${lkj.trainWeight} t`], ['辆数', `${lkj.carCount}`], ['计长', fmt(lkj.trainLength, 1)], ['本/补', '本务'],
    ];
    return this.detailPage('参数设定（运行考评锁定）', rows, `考生：${this.candidate.name || '未登记'}　线路：${lkj.lineName}`);
  }

  revealPage(currentOnly, s, scenario) {
    const remaining = Math.max(0, scenario.entryDistance - s.distance);
    const rows = [
      ['运行揭示', '本次无临时限速揭示'], ['线路', scenario.lkj.lineName], ['前方目标', scenario.entrySignalName],
      ['目标距离', `${fmt(remaining)} m`], ['线路限速', `${fmt(s.lkjLineLimit)} km/h`], ['模式限速', `${fmt(s.lkjModeLimit)} km/h`],
      ['目标速度', `${scenario.maximumEntrySpeed} km/h`], ['揭示条数', '0 条'],
    ];
    return this.detailPage(currentOnly ? '当前揭示' : '全部揭示', rows, currentOnly ? '当前起控揭示查询' : '本次运行揭示总览');
  }

  recordsPage(s) {
    const records = s.events.slice(0, Math.max(0, s.events.length - (this.recordOffset || 0))).slice(-8).reverse();
    return `<section class="lkj-native-dialog lkj-record-dialog"><header>运行记录</header><ul>${records.map((event) => `<li><span>${escapeHtml(this.eventLabel(event.type))}</span><b>${fmt(event.elapsed)}s</b><em>${fmt(event.speed)} km/h</em></li>`).join('') || '<li>暂无记录</li>'}</ul><footer>↑↓翻阅　确认返回</footer></section>`;
  }

  mainPage(s, scenario) {
    const controlPoints = [];
    for (let distance = s.distance - 1000; distance <= s.distance + 4000; distance += 40) {
      const x = this.chartX(distance, s.distance);
      controlPoints.push(`${x.toFixed(1)},${this.speedY(lkjControlLimit(scenario, distance)).toFixed(1)}`);
    }
    const speedScale = Array.from({ length: CHART.speedMaximum / CHART.speedTick + 1 }, (_, index) => index * CHART.speedTick)
      .map((speed) => {
        const y = this.speedY(speed);
        return `<g class="lkj-speed-tick"><line class="lkj-speed-grid" x1="${CHART.left}" y1="${y}" x2="${CHART.right}" y2="${y}"/><line x1="43" y1="${y}" x2="${CHART.left}" y2="${y}"/><text x="41" y="${y + 4}">${speed}</text></g>`;
      }).join('');
    const limitLabels = (scenario.controlTargets || []).map((target) => {
      const x = this.chartX(target.distance, s.distance);
      if (x < CHART.left || x > CHART.right) return '';
      return `<text class="lkj-native-limit-value" x="${x + 5}" y="${this.speedY(target.speed) - 6}">${target.speed}</text>`;
    }).join('');
    const lineLimitLabels = (scenario.lineLimits || []).map((segment) => {
      const x = this.chartX(segment.start, s.distance);
      if (x < CHART.left || x > CHART.right) return '';
      return `<text class="lkj-native-limit-value" x="${x + 5}" y="${this.speedY(segment.limit) - 6}">${segment.limit}</text>`;
    }).join('');
    const speedSamples = [...s.samples];
    if (!speedSamples.length || speedSamples.at(-1).distance !== s.distance) speedSamples.push({ distance: s.distance, speed: s.speed });
    const speedPoints = speedSamples
      .filter((sample) => sample.distance >= s.distance - 1000 && sample.distance <= s.distance)
      .map((sample) => `${this.chartX(sample.distance, s.distance).toFixed(1)},${this.speedY(sample.speed).toFixed(1)}`)
      .join(' ');
    const signalMarkers = scenario.signals.map((signal) => {
      const x = this.chartX(signal.distance, s.distance);
      if (x < CHART.left || x > CHART.right) return '';
      return `<g class="lkj-signal-marker"><line x1="${x}" y1="${CHART.top}" x2="${x}" y2="${CHART.bottom}"/><circle cx="${x}" cy="${CHART.bottom - 8}" r="4"/><text x="${x + 3}" y="${CHART.top + 13}">${escapeHtml(signal.label.replace(/信号机/g, ''))}</text></g>`;
    }).join('');
    const profile = this.routeProfile(s.distance, scenario);
    const facilities = routeFacilitiesForScenario(scenario).map((facility) => {
      const x1 = this.chartX(facility.start, s.distance);
      const x2 = this.chartX(facility.end, s.distance);
      if (x2 < CHART.left || x1 > CHART.right) return '';
      const left = clamp(x1, CHART.left, CHART.right);
      const right = clamp(x2, CHART.left, CHART.right);
      return `<g class="lkj-facility ${facility.type}"><rect x="${left}" y="467" width="${Math.max(3, right - left)}" height="28"/><text x="${left + 3}" y="485">${facility.type === 'bridge' ? '桥' : '隧'}</text></g>`;
    }).join('');
    const levelLabels = { normal: '通常监控', warning: '接近限速', unload: '卸载指令', service: '常用制动', emergency: '紧急制动' };
    const condition = this.conditionVisible ? `<aside class="lkj-native-equipment"><b>原边电流 <em>${fmt(s.tractionCurrent)} A</em></b><b>列车管压力 <em>${fmt(s.trainPipe)} kPa</em></b><b>制动缸压力1 <em>${fmt(s.brakeCylinder)} kPa</em></b><b>均衡风缸 <em>${fmt(s.equalizingReservoir)} kPa</em></b><b>网压 <em>${fmt(s.netVoltage / 100, 1)} kV</em></b><b>工况 <em>${s.traction > 0 ? `牵引${s.traction}级/${fmt(s.tractionTargetSpeed)}` : s.traction < 0 ? `电制${-s.traction}级` : '惰行'}</em></b><b>平衡速度 <em>${fmt(s.balanceSpeed)} km/h</em></b><b>通道速度 <em>${fmt(s.speed)}　${fmt(s.speed)}　${fmt(s.speed)}</em></b><small>按“确认”关闭</small></aside>` : '';
    const trainLength = Math.min(105, Math.max(12, scenario.lkj.carCount * 25 * CHART.pixelsPerMeter));
    return `<div class="lkj-native-monitor level-${s.lkjLevel}"><svg viewBox="0 0 800 615" preserveAspectRatio="none" aria-label="LKJ运行监控曲线">
      <rect class="lkj-speed-scale-bg" x="1" y="${CHART.top}" width="48" height="${CHART.bottom - CHART.top}"/>${speedScale}
      <polyline class="lkj-native-limit-line" points="${controlPoints.join(' ')}"/>${lineLimitLabels}${limitLabels}
      ${signalMarkers}<line class="lkj-native-position-line" x1="${CHART.position}" y1="${CHART.top}" x2="${CHART.position}" y2="500"/>
      <polyline class="lkj-native-speed-line" points="${speedPoints}"/><polyline class="lkj-grade-line" points="${profile.gradePoints}"/><line class="lkj-grade-zero" x1="${CHART.left}" y1="411" x2="${CHART.right}" y2="411"/>
      <polyline class="lkj-curve-line" points="${profile.curvePoints}"/>${facilities}
      <rect class="lkj-train-icon" x="${CHART.position - trainLength}" y="384" width="${trainLength}" height="8"/><circle class="lkj-train-head" cx="${CHART.position}" cy="388" r="4"/>
      <text class="lkj-window-label" x="56" y="78">后方1km</text><text class="lkj-window-label" x="675" y="78">前方4km</text></svg>
      ${condition}<div class="lkj-native-status">${levelLabels[s.lkjLevel]}　${this.aspectLabel(s.signal.aspect)}　控制速度 ${fmt(s.lkjLimit)} km/h</div></div>`;
  }

  routeProfile(currentDistance, scenario) {
    const key = `${scenario.id}:${Math.floor(currentDistance / 25)}`;
    if (this.profileCache?.key === key) return this.profileCache;
    const grade = [];
    const curve = [];
    for (let distance = currentDistance - 1000; distance <= currentDistance + 4000; distance += 80) {
      const sampled = this.routeSampler(distance) || {};
      const x = this.chartX(distance, currentDistance);
      grade.push(`${x.toFixed(1)},${(411 - clamp(Number(sampled.grade) || 0, -35, 35) / 35 * 13).toFixed(1)}`);
      curve.push(`${x.toFixed(1)},${(447 - clamp(Number(sampled.curve) || 0, -0.02, 0.02) / 0.02 * 12).toFixed(1)}`);
    }
    this.profileCache = { key, gradePoints: grade.join(' '), curvePoints: curve.join(' ') };
    return this.profileCache;
  }

  chartX(distance, currentDistance) {
    return CHART.position + (distance - currentDistance) * CHART.pixelsPerMeter;
  }

  speedY(speed) {
    return CHART.bottom - clamp(Number(speed) || 0, 0, CHART.speedMaximum) / CHART.speedMaximum * (CHART.bottom - CHART.top);
  }

  detailPage(title, rows, footer = '确认：返回监控　←：查询菜单') {
    return `<section class="lkj-native-dialog lkj-detail-dialog"><header>${escapeHtml(title)}</header><dl>${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><footer>${escapeHtml(footer)}</footer></section>`;
  }

  aspectLabel(aspect) {
    return ({ green: '绿灯', greenYellow: '绿黄灯', 'green-yellow': '绿黄灯', 'double-yellow': '双黄灯', yellow: '黄灯', redYellow: '红黄灯', 'red-yellow': '红黄灯', red: '红灯' })[aspect] || aspect;
  }

  eventLabel(type) {
    return ({
      'attempt-start': '任务开始', 'auto-brake': '自阀操作', traction: '牵引操作', callout: '信号呼唤', 'lkj-level': '监控状态',
      'entry-signal': '越过进站信号机', 'first-brake-point': '通过第一次制动点', 'tail-query-point': '通过列尾查询点', 'second-brake-point': '通过第二次制动点',
      'brake-release': '自阀缓解', 'brake-pipe-charged': '列车管充风完成', 'cir-action': 'CIR操作',
      'train-stop': '列车停稳', 'brake-addition': '自阀追加', 'independent-brake': '单阀操作',
      'side-release': '单缓操作', 'attempt-complete': '停车防溜完成', 'lkj-ack': '报警确认',
      'lkj-start-align': '开车对标', 'lkj-position-correct': '车位校正', 'lkj-mark': '定标记录', 'lkj-patrol': '巡检记录',
    })[type] || type;
  }
}

export { MENU as LKJ_QUERY_MENU, CHART as LKJ_CHART };
