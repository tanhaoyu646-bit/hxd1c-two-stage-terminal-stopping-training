import * as THREE from '../lib/three/three.module.js';
import { MstsRouteScene } from './mstsRouteScene.js?v=two-stage-2';

export class TerminalStoppingScene extends MstsRouteScene {
  constructor(canvas, scenario, mode = 'training') {
    super(canvas, { profile: 'terminal-station', routeWindow: scenario.routeWindow });
    this.stoppingScenario = scenario;
    this.trainingMode = mode === 'training';
    this.startOffset = scenario.startOffset;
    this.stationObjects = [];
    this.trainingAids = [];
  }

  async load() {
    await super.load();
    this.startOffset = this.stoppingScenario.startOffset;
    this.buildStoppingMarker();
    this.buildDistanceAids();
    this.applyCamera();
  }

  makeTextTexture(text, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = options.width || 512;
    canvas.height = options.height || 192;
    const context = canvas.getContext('2d');
    context.fillStyle = options.background || '#f7f7ef';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = options.border || '#142b58';
    context.lineWidth = options.lineWidth || 16;
    context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    context.fillStyle = options.color || '#102350';
    context.font = options.font || 'bold 74px "Microsoft YaHei", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const lines = String(text).split('\n');
    const lineHeight = options.lineHeight || canvas.height / Math.max(1, lines.length + .35);
    const firstLine = canvas.height / 2 - (lines.length - 1) * lineHeight / 2;
    lines.forEach((line, index) => context.fillText(line, canvas.width / 2, firstLine + index * lineHeight));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  buildStoppingMarker() {
    const scenario = this.stoppingScenario;
    const root = new THREE.Group();
    root.name = 'TERMINAL_STOPPING_MARKER';
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(.065, .085, 2.45, 10),
      new THREE.MeshStandardMaterial({ color: '#d7d9d5', roughness: .7 }),
    );
    pole.position.y = 1.225;
    root.add(pole);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(.88, 1.92),
      new THREE.MeshBasicMaterial({
        map: this.makeTextTexture('机车\n停车\n位置', { width: 256, height: 560, background: '#f7f7f2', border: '#171717', color: '#171717', font: 'bold 82px "Microsoft YaHei", sans-serif', lineHeight: 142, lineWidth: 12 }),
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    board.position.y = 2.82;
    board.rotation.y = Math.PI;
    root.add(board);
    this.placeLookoutObject3D(root, scenario.startOffset + scenario.targetDistance, -3.25, 0);
    this.routeRoot.add(root);
    this.stationObjects.push({ root, distance: scenario.targetDistance, range: 1_300 });
  }

  buildDistanceAids() {
    const scenario = this.stoppingScenario;
    const aids = [
      { distance: scenario.firstBrakePoint, label: '距标400 m · 第一次制动' },
      { distance: scenario.tailQueryPoint, label: '查询列尾风压' },
      { distance: scenario.secondBrakePoint, label: '距标20 m · 第二次制动' },
    ];
    for (const aid of aids) {
      const root = new THREE.Group();
      root.name = `TRAINING_AID_${aid.distance}`;
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, .9),
        new THREE.MeshBasicMaterial({
          map: this.makeTextTexture(aid.label, { width: 512, height: 192, background: '#082c3e', border: '#63def6', color: '#e9fbff', font: 'bold 54px "Microsoft YaHei", sans-serif', lineWidth: 10 }),
          transparent: true,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      board.position.y = 2.1;
      board.rotation.y = Math.PI;
      root.add(board);
      this.placeLookoutObject3D(root, scenario.startOffset + aid.distance, -4.1, 0);
      root.visible = this.trainingMode;
      this.routeRoot.add(root);
      this.trainingAids.push(root);
      this.stationObjects.push({ root, distance: aid.distance, range: 650, trainingOnly: true });
    }
  }

  setTrainingMode(training) {
    this.trainingMode = Boolean(training);
    this.trainingAids.forEach((root) => { root.visible = this.trainingMode; });
  }

  update(distance, speed, view = this.view) {
    super.update(distance, speed, view, true, 1);
    for (const item of this.stationObjects) {
      if (item.trainingOnly && !this.trainingMode) item.root.visible = false;
      else item.root.visible = Math.abs(item.distance - distance) < item.range;
    }
  }
}
