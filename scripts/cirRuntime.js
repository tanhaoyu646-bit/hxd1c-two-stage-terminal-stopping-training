const CIR_WIDTH = 918;
const CIR_HEIGHT = 600;

export class CirRuntime {
  constructor(simulation) {
    this.simulation = simulation;
    this.root = document.createElement('div');
    this.root.className = 'cir-modal';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `<div class="cir-device" role="dialog" aria-modal="true" aria-label="CIR机车综合无线通信设备">
      <header><b>CIR 机车综合无线通信设备</b><button type="button" class="cir-close" aria-label="关闭CIR">×</button></header>
      <div class="cir-layout"><div class="cir-frame-wrap"><span class="cir-loading">正在载入 CIR 模拟器…</span><iframe class="cir-frame" title="CIR原模拟器" src="about:blank" sandbox="allow-scripts allow-same-origin allow-modals"></iframe></div>
      <aside class="cir-status"><h3>列尾状态</h3><dl><div><dt>连接</dt><dd data-cir-linked>未连接</dd></div><div><dt>列车管</dt><dd data-cir-head>600 kPa</dd></div><div><dt>列尾风压</dt><dd data-cir-tail>600 kPa</dd></div><div><dt>最近查询</dt><dd data-cir-query>未查询</dd></div></dl><p data-cir-message>请在 CIR 原界面操作。</p></aside></div>
    </div>`;
    document.body.append(this.root);
    this.frame = this.root.querySelector('iframe');
    this.frame.addEventListener('load', () => this.installBridge());
    this.root.querySelector('.cir-close').addEventListener('click', () => this.close());
    this.root.addEventListener('click', (event) => { if (event.target === this.root) this.close(); });
    window.addEventListener('resize', () => this.fit());
  }

  setSimulation(simulation) {
    this.simulation = simulation;
    this.query = null;
    this.message = '请在 CIR 原界面操作。';
    this.render();
  }

  get device() { try { return this.frame.contentWindow; } catch { return null; } }
  get linked() { return /^\d{7}$/.test(String(this.device?.mmiinfo?.[1] || '')); }

  open() {
    if (!this.frame.dataset.loaded) { this.frame.dataset.loaded = '1'; this.frame.src = './assets/cir/CIR-simulator.html'; }
    this.root.classList.add('open');
    this.root.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { this.fit(); this.installBridge(); this.render(); });
  }

  close() { this.root.classList.remove('open'); this.root.setAttribute('aria-hidden', 'true'); }

  fit() {
    const bounds = this.root.querySelector('.cir-frame-wrap').getBoundingClientRect();
    if (bounds.width && bounds.height) this.root.style.setProperty('--cir-scale', Math.min(bounds.width / CIR_WIDTH, bounds.height / CIR_HEIGHT).toFixed(4));
  }

  installBridge() {
    const device = this.device;
    try {
      if (!device?.document?.getElementById('mmibody') || typeof device.buttonfix !== 'function') return;
      if (!device.__terminalStoppingCirBridge) {
        const original = device.buttonfix;
        device.buttonfix = (...args) => {
          const result = original.apply(device, args);
          this.onKey(String(args[0]));
          return result;
        };
        device.__terminalStoppingCirBridge = true;
      }
      if (Array.isArray(device.mmiinfo)) {
        device.mmiinfo[1] ||= '9123456';
        device.mmiinfo[2] = 'H2026';
      }
      const tailState = device.document?.getElementById('lwstate');
      if (tailState) tailState.textContent = '已连接 123456';
      this.root.querySelector('.cir-loading').hidden = true;
      this.syncPressure();
    } catch { /* 加载中，下次渲染重试。 */ }
  }

  syncPressure() {
    const device = this.device;
    if (!Array.isArray(device?.mmiinfo)) return;
    const pressure = Math.max(0, Math.round(this.simulation.state.tailPipe));
    device.mmiinfo[3] = String(pressure).padStart(4, '0');
    const shown = device.document?.getElementById('lwfyvalue');
    if (shown) shown.textContent = String(pressure);
  }

  onKey(code) {
    const state = this.simulation.state;
    this.syncPressure();
    if (code === 'bt12') {
      if (!this.linked) this.message = '列尾未连接，查询无效。';
      else {
        this.query = Math.round(state.tailPipe);
        this.message = `列尾风压 ${this.query} kPa，机车列车管 ${Math.round(state.trainPipe)} kPa。`;
        this.simulation.command('cir-action', { type: 'tail-query', pressure: this.query });
      }
    } else if (code === 'bt9') {
      this.message = this.linked ? '列尾排风操作已记录。' : '列尾未连接，排风无效。';
      if (this.linked) this.simulation.command('cir-action', { type: 'tail-exhaust' });
    } else if (code === 'bt10') { this.query = null; this.message = '列尾装置已销号。'; }
    else if (code === 'bt4') this.simulation.command('cir-action', { type: 'station-select' });
    else if (code === 'rt1') this.simulation.command('cir-action', { type: 'call' });
    else if (code === 'rt9') this.simulation.command('cir-action', { type: 'hang-up' });
    this.render();
  }

  render() {
    if (this.root.classList.contains('open')) this.installBridge();
    const state = this.simulation.state;
    this.root.querySelector('[data-cir-linked]').textContent = this.linked ? String(this.device.mmiinfo[1]).slice(1) : '未连接';
    this.root.querySelector('[data-cir-head]').textContent = `${Math.round(state.trainPipe)} kPa`;
    this.root.querySelector('[data-cir-tail]').textContent = `${Math.round(state.tailPipe)} kPa`;
    this.root.querySelector('[data-cir-query]').textContent = this.query == null ? '未查询' : `${this.query} kPa`;
    this.root.querySelector('[data-cir-message]').textContent = this.message || '请在 CIR 原界面操作。';
    this.syncPressure();
  }
}


