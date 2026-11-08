import * as THREE from '../lib/three/three.module.js';
import { ROUTE_CONTEXT } from './smoothStartConfig.js';
import { buildRailAlignedPath, cumulativePathDistances } from './railAlignedPath.js';
import { LOOKOUT_TRAINING_CONFIG } from './lookoutTrainingConfig.js';

// fetch() 的相对地址以页面而非当前模块为基准；GitHub Pages 位于仓库子目录，
// 因此所有三维资源必须相对 import.meta.url 解析，不能使用普通 ../assets 字符串。
const SOURCE_PATH = new URL('../assets/msts-neiyi-corridor/neiyi-lookout-full-scene.json', import.meta.url).href;
const ROUTE_PATH = new URL('../assets/msts-neiyi/neiyi-5635-trackdb-path.json', import.meta.url).href;
const TERMINAL_STATION_SOURCE_PATH = new URL('../assets/msts-neiyi-corridor/neiyi-dashanpu-terminal-scene.json?v=two-stage-2', import.meta.url).href;
const TERMINAL_STATION_ROUTE_PATH = new URL('../assets/msts-neiyi/neiyi-5635-trackdb-path-aligned.json?v=two-stage-2', import.meta.url).href;
const TERRAIN_PATH = new URL('../assets/msts-neiyi-corridor/neiyi-lookout-terrain.json', import.meta.url).href;
const LOOKOUT_TERRAIN_PATH = new URL('../assets/msts-neiyi-corridor/neiyi-lookout-terrain-native.json', import.meta.url).href;
const TERMINAL_STATION_TERRAIN_PATH = new URL('../assets/msts-neiyi-corridor/neiyi-dashanpu-terrain-native.json', import.meta.url).href;
const LOOKOUT_PREFAB_PATH = new URL('../assets/msts-neiyi-corridor/lookout-source-prefabs.json', import.meta.url).href;
const LOOKOUT_REPAIR_ASSET_PATH = new URL('../assets/msts-neiyi-corridor/lookout-repair-assets.json', import.meta.url).href;
const TEXTURE_PATH = new URL('../assets/msts-neiyi-corridor/textures/', import.meta.url).href;
// GitHub Pages 区分大小写；原游戏导出中的三处引用大小写与发布文件名不同。
const TEXTURE_FILE_ALIASES = Object.freeze({
  'acleanttrack1.png': 'ACleanTrack1.png',
  'acleanttrack2.png': 'ACleanTrack2.png',
  'acleantrack1.png': 'ACleanTrack1.png',
  'acleantrack2.png': 'ACleanTrack2.png',
  'sign.png': 'Sign.png',
});
// 原游戏世界块提供场景、道岔、信号机和隧道；同一条 TrackDB 中心线
// 同时生成连续的训练线路表面，避免 MSTS 分节模型在 WebGL 中出现接缝。
const DEFAULT_ROUTE_RENDER_OPTIONS = Object.freeze({
  proceduralTrack: true,
  railHighlights: true,
  continuousRailHeads: false,
  sourceDepartureSignal: true,
});

const LOOKOUT_ROUTE_RENDER_OPTIONS = Object.freeze({
  proceduralTrack: true,
  railHighlights: false,
  continuousRailHeads: true,
  sourceDepartureSignal: true,
});

const TERMINAL_STATION_RENDER_OPTIONS = Object.freeze({
  proceduralTrack: true,
  railHighlights: false,
  continuousRailHeads: true,
  sourceDepartureSignal: false,
});

// 电分相考核使用独立、按教学里程布置的标志。原线路在同一走廊内还带有
// 既有断电牌、禁止双弓牌、曲线牌和信号机，若同时渲染会造成重复和错序。
const POWER_TRAINING_SUPPRESSED_SHAPES = /^(?:duan|jinzhi-shuanggong|quxianbiao|qiaoliangbiao)\.s$/i;

export class MstsRouteScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.profile = options.profile || 'departure';
    this.isLookout = this.profile === 'lookout';
    this.isPowerTraining = this.profile === 'power-training';
    this.isTerminalStation = this.profile === 'terminal-station';
    this.isCorridor = this.isLookout || this.isPowerTraining || this.isTerminalStation;
    this.routeWindow = options.routeWindow || null;
    this.renderOptions = this.isTerminalStation
      ? TERMINAL_STATION_RENDER_OPTIONS
      : this.isCorridor ? LOOKOUT_ROUTE_RENDER_OPTIONS : DEFAULT_ROUTE_RENDER_OPTIONS;
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.mobileOptimized = coarse;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.15 : 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#a7bdca');
    this.scene.fog = new THREE.Fog('#a7b9c2', 500, 2200);
    this.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.15, 3000);
    this.routeRoot = new THREE.Group();
    this.routeRoot.name = 'MSTS_ROUTE_ROOT';
    this.scene.add(this.routeRoot);
    this.view = 'front';
    this.distance = 0;
    this.startOffset = 0;
    this.eyeHeight = 3.82;
    this.ready = false;
    this.error = null;
    this.routePoints = [];
    this.routeDistances = [];
    this.pathLength = 0;
    this.forward = new THREE.Vector3(0, 0, -1);
    this.baseYaw = Math.atan2(-this.forward.x, -this.forward.z);
    this.signalAspect = 'green';
    this.scenarioId = 'normal';
    this.signalLampVisibility = 1;
    this.startMotionAt = null;
    this.lastStartFraction = 0;
    this.departureSignal = null;
    this.neighborSignal = null;
    this.throughSignal = null;
    this.throughSignals = [];
    this.passengerCars = [];
    this.lookoutRoot = null;
    this.lookoutVisuals = {};
    this.railVisibilityMaterials = [];
    this.intrusionVehicleMotionStart = null;
    this.lookoutCatenaryRepairDistances = [];
    this.signalRaycaster = new THREE.Raycaster();
    this.signalPointer = new THREE.Vector2();
    this.materialCache = new Map();
    this.textureLoader = new THREE.TextureLoader();
    this.addEnvironment();
    this.applyCamera();
    this.loadPromise = this.load();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();
  }

  addEnvironment() {
    this.scene.add(new THREE.HemisphereLight('#eaf6ff', '#687264', 2.0));
    const sun = new THREE.DirectionalLight('#fff2d8', 2.4);
    sun.position.set(-120, 150, 80);
    this.scene.add(sun);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(5200, 5200),
      new THREE.MeshStandardMaterial({ color: '#71806e', roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.18;
    this.ground.frustumCulled = false;
    this.ground.material.depthWrite = false;
    this.ground.renderOrder = -10;
    this.scene.add(this.ground);
  }

  async load() {
    try {
      const requests = [
        fetch(this.isTerminalStation ? TERMINAL_STATION_SOURCE_PATH : SOURCE_PATH),
        fetch(this.isTerminalStation ? TERMINAL_STATION_ROUTE_PATH : ROUTE_PATH),
        fetch(this.isTerminalStation
          ? TERMINAL_STATION_TERRAIN_PATH
          : this.isCorridor ? LOOKOUT_TERRAIN_PATH : TERRAIN_PATH),
      ];
      if (this.isLookout) {
        requests.push(fetch(LOOKOUT_PREFAB_PATH));
        requests.push(fetch(LOOKOUT_REPAIR_ASSET_PATH));
      }
      const [sceneResponse, pathResponse, terrainResponse, prefabResponse, repairAssetResponse] = await Promise.all(requests);
      if (!sceneResponse.ok) throw new Error(`路线场景加载失败：HTTP ${sceneResponse.status}`);
      if (!pathResponse.ok) throw new Error(`轨道中心线加载失败：HTTP ${pathResponse.status}`);
      if (!terrainResponse.ok) throw new Error(`原线路地形加载失败：HTTP ${terrainResponse.status}`);
      if (this.isLookout && !prefabResponse?.ok) throw new Error(`原线路素材加载失败：HTTP ${prefabResponse?.status}`);
      if (this.isLookout && !repairAssetResponse?.ok) throw new Error(`原游戏补充素材加载失败：HTTP ${repairAssetResponse?.status}`);
      const [sceneData, pathData, terrainData, prefabData, repairAssetData] = await Promise.all([
        sceneResponse.json(),
        pathResponse.json(),
        terrainResponse.json(),
        prefabResponse?.json() || null,
        repairAssetResponse?.json() || null,
      ]);
      if (repairAssetData?.shapes?.['tongguo.s']) {
        repairAssetData.shapes['tongguo.s'].materials.forEach((material) => {
          if (material.texture === 'Sign.png') material.texture = 'throughSignalSign.png';
        });
      }
      this.buildRoutePath(pathData, sceneData);
      if (this.isCorridor) {
        // 本务线钢轨在加载时已经覆盖完整 TrackDB 路径；远裁剪面也必须覆盖同一范围，
        // 不能再用旧版 3 km 视距把实际存在的三维钢轨截掉。
        this.camera.far = this.isTerminalStation
          ? Math.max(3_500, (Number(this.routeWindow?.end) || 0) - (Number(this.routeWindow?.start) || 0) + 1_400)
          : Math.max(50_000, Math.ceil(this.pathLength + 1_000));
        this.camera.userData.fullRouteFarPlane = true;
        this.camera.updateProjectionMatrix();
      }
      this.buildTerrain(terrainData);
      this.buildRoute(sceneData);
      this.buildPassengerConsist(12);
      // 瞭望项目的本务主线在加载时一次性生成到 TrackDB 路径终点。
      // 课程仍在6 km结算，但不再因考核终点人为截断三维钢轨。
      const renderedRouteStart = this.isTerminalStation
        ? Math.max(0, Number(this.routeWindow?.start) || 0)
        : 0;
      const renderedRouteDistance = this.isTerminalStation
        ? Math.min(this.pathLength, Number(this.routeWindow?.end) || this.pathLength)
        : this.isCorridor
          ? this.pathLength
        : Math.min(this.pathLength, LOOKOUT_TRAINING_CONFIG.finishDistance + 350);
      const railEvent = LOOKOUT_TRAINING_CONFIG.events.find((item) => item.visualKind === 'rail');
      if (this.renderOptions.proceduralTrack) this.buildSelectedRouteTrack(renderedRouteDistance, renderedRouteStart);
      if (this.renderOptions.railHighlights) this.buildRailHighlights(renderedRouteDistance, railEvent);
      if (this.renderOptions.continuousRailHeads) this.buildContinuousRailHeads(renderedRouteDistance, renderedRouteStart);
      if (this.renderOptions.sourceDepartureSignal && !this.isPowerTraining) this.buildSourceDepartureSignal(sceneData);
      if (!this.isPowerTraining) this.buildSourceRouteSignalLights(sceneData);
      if (this.isLookout) this.buildLookoutTrainingScenery(sceneData, prefabData, repairAssetData);
      this.ready = true;
      this.applyCamera();
      this.canvas.dispatchEvent(new CustomEvent('route-ready', {
        detail: { ...sceneData.summary, ...pathData.summary, pathLength: this.pathLength },
      }));
    } catch (error) {
      this.error = error;
      this.canvas.dispatchEvent(new CustomEvent('route-error', { detail: error }));
      throw error;
    }
  }

  buildTerrain(data) {
    const tileSize = Number(data?.source?.tileSize) || 2048;
    const [originX, , originZ] = data?.source?.origin || [604.624, 1289.16, -775.032];
    const [originTileX, originTileZ] = data?.source?.originTile || [-5742, 14701];
    const terrainTexture = this.textureLoader.load(`${TEXTURE_PATH}terrain.png`);
    terrainTexture.colorSpace = THREE.SRGBColorSpace;
    terrainTexture.wrapS = terrainTexture.wrapT = THREE.RepeatWrapping;
    terrainTexture.repeat.set(18, 18);
    terrainTexture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    const microTexture = this.textureLoader.load(`${TEXTURE_PATH}microtex.png`);
    microTexture.wrapS = microTexture.wrapT = THREE.RepeatWrapping;
    microTexture.repeat.set(18, 18);
    const material = new THREE.MeshStandardMaterial({
      color: '#8a9878',
      map: terrainTexture,
      bumpMap: microTexture,
      bumpScale: 0.28,
      roughness: 0.98,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const root = new THREE.Group();
    root.name = 'MSTS_SOURCE_TERRAIN';
    root.userData.sourceResolution = Number(data?.summary?.resolution) || 0;
    root.userData.railwayCorridorLimited = this.isCorridor;
    const corridorIndex = this.isCorridor ? this.buildTerrainCorridorIndex() : null;
    for (const tile of data?.tiles || []) {
      const resolution = Number(tile.resolution) || 0;
      if (resolution < 3 || tile.heights?.length !== resolution * resolution) continue;
      const positions = [];
      const uvs = [];
      const indices = [];
      for (let row = 0; row < resolution; row += 1) {
        const rowRatio = row / (resolution - 1);
        const localZ = tileSize * 0.5 - rowRatio * tileSize;
        for (let column = 0; column < resolution; column += 1) {
          const columnRatio = column / (resolution - 1);
          const localX = -tileSize * 0.5 + columnRatio * tileSize;
          const x = -(((tile.tileX - originTileX) * tileSize) + localX - originX);
          const z = ((tile.tileZ - originTileZ) * tileSize) + localZ - originZ;
          const sourceHeight = Number(tile.heights[row * resolution + column]) - 0.12;
          const y = corridorIndex ? this.limitTerrainAtRailway(x, z, sourceHeight, corridorIndex) : sourceHeight;
          positions.push(x, y, z);
          uvs.push(columnRatio, 1 - rowRatio);
        }
      }
      for (let row = 0; row < resolution - 1; row += 1) {
        for (let column = 0; column < resolution - 1; column += 1) {
          const a = row * resolution + column;
          const b = a + 1;
          const c = a + resolution;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `MSTS_TERRAIN_${tile.tileX}_${tile.tileZ}`;
      // 原线地形使用 MSTS 的大坐标。浏览器在远离世界原点时偶尔会把
      // 仍包围驾驶视点的 2 km 地形块误判到视锥外，表现为轨道和站台悬空。
      // 当前专项只装载 6 块站场地形，关闭块级裁剪的成本可控且能稳定显示。
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    this.routeRoot.add(root);
    this.terrainRoot = root;
    if (root.children.length && this.ground) this.ground.visible = false;
  }

  buildTerrainCorridorIndex() {
    const cellSize = 32;
    const outerWidth = 24;
    const minimumDistance = this.isTerminalStation
      ? Math.max(0, Number(this.routeWindow?.start) || 0)
      : 0;
    const maximumDistance = Math.min(
      this.pathLength,
      this.isTerminalStation
        ? Number(this.routeWindow?.end) || this.pathLength
        : LOOKOUT_TRAINING_CONFIG.finishDistance + 350,
    );
    const cells = new Map();
    const segments = [];
    for (let index = 1; index < this.routePoints.length; index += 1) {
      if (this.routeDistances[index] < minimumDistance) continue;
      if (this.routeDistances[index - 1] > maximumDistance) break;
      const a = this.routePoints[index - 1];
      const b = this.routePoints[index];
      const segmentIndex = segments.length;
      segments.push({ a, b });
      const minCellX = Math.floor((Math.min(a.x, b.x) - outerWidth) / cellSize);
      const maxCellX = Math.floor((Math.max(a.x, b.x) + outerWidth) / cellSize);
      const minCellZ = Math.floor((Math.min(a.z, b.z) - outerWidth) / cellSize);
      const maxCellZ = Math.floor((Math.max(a.z, b.z) + outerWidth) / cellSize);
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
          const key = `${cellX},${cellZ}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(segmentIndex);
        }
      }
    }
    // 8 m高程格点不一定落在轨道中心，12 m内平整可确保中心线
    // 周围至少两列格点受控；24 m外完全恢复原地形。
    return { cellSize, innerWidth: 12, outerWidth, cells, segments };
  }

  limitTerrainAtRailway(x, z, sourceHeight, index) {
    const key = `${Math.floor(x / index.cellSize)},${Math.floor(z / index.cellSize)}`;
    const candidates = index.cells.get(key);
    if (!candidates?.length) return sourceHeight;
    let bestDistance = Number.POSITIVE_INFINITY;
    let railwayHeight = sourceHeight;
    for (const segmentIndex of candidates) {
      const { a, b } = index.segments[segmentIndex];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSquared = dx * dx + dz * dz;
      const ratio = lengthSquared > 0
        ? THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / lengthSquared, 0, 1)
        : 0;
      const projectedX = a.x + dx * ratio;
      const projectedZ = a.z + dz * ratio;
      const distance = Math.hypot(x - projectedX, z - projectedZ);
      if (distance < bestDistance) {
        bestDistance = distance;
        railwayHeight = THREE.MathUtils.lerp(a.y, b.y, ratio);
      }
    }
    if (bestDistance >= index.outerWidth) return sourceHeight;
    const blend = bestDistance <= index.innerWidth
      ? 1
      : 1 - THREE.MathUtils.smoothstep(bestDistance, index.innerWidth, index.outerWidth);
    const corridorCap = railwayHeight + 0.02;
    return Math.min(sourceHeight, THREE.MathUtils.lerp(sourceHeight, corridorCap, blend));
  }

  getMaterial(definition) {
    const textureName = definition?.texture || '';
    const fileName = TEXTURE_FILE_ALIASES[textureName.toLowerCase()] || textureName;
    const materialName = definition?.name || '';
    const key = `${fileName}|${materialName}|${definition?.alphaTestMode || 0}`;
    if (this.materialCache.has(key)) return this.materialCache.get(key);
    let texture = null;
    if (textureName) {
      texture = this.textureLoader.load(`${TEXTURE_PATH}${encodeURIComponent(fileName)}`);
      // MSTS 的 UV 原点和 Three.js 图像上传默认相反。保留导出 UV 时必须禁用二次翻转，
      // 否则树木与楼房纹理会整体倒置。
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    }
    const isTrackMaterial = /track/i.test(textureName);
    const isRailTop = /rail[_ ]?tops?/i.test(materialName);
    const isRailSide = /rail[_ ]?side/i.test(materialName);
    const materialParameters = {
      color: texture ? 0xffffff : 0xadb5b3,
      map: texture,
      roughness: isRailTop ? 0.18 : isRailSide ? 0.42 : isTrackMaterial ? 0.84 : 0.88,
      metalness: isRailTop ? 0.9 : isRailSide ? 0.5 : isTrackMaterial ? 0.08 : 0.03,
      side: THREE.DoubleSide,
      alphaTest: texture ? 0.08 : 0,
    };
    const material = isRailTop
      ? new THREE.MeshPhysicalMaterial({
        ...materialParameters,
        clearcoat: 0.72,
        clearcoatRoughness: 0.12,
      })
      : new THREE.MeshStandardMaterial(materialParameters);
    if (isRailTop) {
      material.emissive.set('#26343b');
      material.emissiveIntensity = 0.16;
    }
    material.name = definition?.name || textureName || 'MSTS_MATERIAL';
    this.materialCache.set(key, material);
    return material;
  }

  createSourceShapeObject(data, fileName, name = fileName, options = {}) {
    const shape = data?.shapes?.[fileName];
    if (!shape?.groups?.length) return null;
    const root = new THREE.Group();
    root.name = name;
    shape.groups.forEach((group, groupIndex) => {
      if (!group.positions?.length) return;
      const materialDefinition = shape.materials[group.materialIndex];
      if (options.groupFilter && !options.groupFilter(group, groupIndex, materialDefinition)) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
      if (group.uvs?.length === (group.positions.length / 3) * 2) {
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
      }
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.getMaterial(materialDefinition));
      mesh.name = `${fileName}:${groupIndex}`;
      root.add(mesh);
    });
    return root;
  }

  buildRoute(data) {
    const instancesByShape = new Map();
    const corridorStart = this.isTerminalStation
      ? Math.max(0, Number(this.routeWindow?.start) || 0)
      : 0;
    const corridorEnd = this.isTerminalStation
      ? Math.min(this.pathLength, Number(this.routeWindow?.end) || this.pathLength)
      : LOOKOUT_TRAINING_CONFIG.finishDistance + 500;
    const corridorLateral = this.isTerminalStation
      ? Math.max(100, Number(this.routeWindow?.lateral) || 650)
      : 450;
    // A3 多线轨道构件的对象原点可偏离本务线约 5–10 m，但模型本体仍会
    // 横跨本务线。终到专项扩大重复轨道净空带，避免其覆盖连续训练轨面。
    const sourceTrackClearance = this.isTerminalStation ? 14 : 4.2;
    data.instances.forEach((instance) => {
      const projection = this.isCorridor
        ? this.projectPointToPath(instance.position, corridorEnd)
        : null;
      if (this.isCorridor) {
        // 各专项只保留自己的教学走廊及周边可见场景，不把原线路
        // 数十公里的远程实例一起提交给渲染器。终到专项使用实际站场里程窗口。
        if (!projection
          || projection.alongDistance < corridorStart
          || projection.alongDistance > corridorEnd
          || projection.lateralDistance > corridorLateral) return;
        const tunnel = LOOKOUT_TRAINING_CONFIG.events.find((item) => item.visualKind === 'tunnel');
        const insideTeachingTunnel = this.isLookout && projection
          && projection.alongDistance >= tunnel.tunnelStartDistance - 4
          && projection.alongDistance <= tunnel.tunnelEndDistance + 4
          && Math.abs(projection.signedLateral) <= 12;
        // 教学隧道已自带轨道、洞壁和洞门，清除这一小段原露天线路上的
        // 接触网杆、信号和轨道，避免它们穿入隧道内部。
        if (insideTeachingTunnel) return;

        // 本项目只显示与当前考核相关、由 powerTrainingScene 按正确顺序
        // 放置的标志；保留原项目中的这些对象会叠出第二套错误序列。
        if (this.isPowerTraining && (
          instance.type === 'SignalObj'
          || POWER_TRAINING_SUPPRESSED_SHAPES.test(instance.shape || '')
        )) return;

        // 原接触网杆的对象原点位于原轨道中心，真正的杆柱约在局部 +X 3 m。
        // 主线中心线重建后，少数杆柱会侵入新线路。按实际杆柱位置做净空判断，
        // 将侵线杆记录下来，稍后沿最终中心线原位重建，而不是只删掉造成断档。
        if (this.isLookout && /^SweGantry1\.s$/i.test(instance.shape || '')) {
          const instancePosition = new THREE.Vector3().fromArray(instance.position);
          const instanceQuaternion = new THREE.Quaternion().fromArray(instance.quaternion).normalize();
          const mastPosition = new THREE.Vector3(3, 0, 0).applyQuaternion(instanceQuaternion).add(instancePosition);
          const mastProjection = this.projectPointToPath(mastPosition.toArray(), LOOKOUT_TRAINING_CONFIG.finishDistance + 350);
          if (mastProjection
            && Math.abs(mastProjection.signedLateral) < 2.65
            && Math.abs(mastProjection.verticalOffset || 0) < 3) {
            this.lookoutCatenaryRepairDistances.push(mastProjection.alongDistance);
            return;
          }
        }
      }
      if (this.renderOptions.proceduralTrack && instance.type === 'TrackObj' && /^A\d+t/i.test(instance.shape || '')) {
        const trackProjection = projection || this.projectPointToPath(instance.position);
        if (trackProjection
          && trackProjection.lateralDistance < sourceTrackClearance
          && trackProjection.alongDistance >= corridorStart
          && trackProjection.alongDistance <= corridorEnd) return;
      }
      if (this.renderOptions.continuousRailHeads && instance.type === 'TrackObj' && /^A\d+t/i.test(instance.shape || '')) {
        const trackProjection = projection || this.projectPointToPath(instance.position);
        // 原分节主线轨道在 WebGL 中的接缝和交叠会造成假分岔；主线由
        // 同一中心线的实体钢轨头和连续轨枕承担，保留侧线和其他原轨道场景。
        if (trackProjection
          && trackProjection.lateralDistance < sourceTrackClearance
          && trackProjection.alongDistance >= corridorStart
          && trackProjection.alongDistance <= corridorEnd) return;
      }
      if (!instancesByShape.has(instance.shape)) instancesByShape.set(instance.shape, []);
      instancesByShape.get(instance.shape).push(instance);
    });

    Object.values(data.shapes).forEach((shape) => {
      const instances = instancesByShape.get(shape.fileName) || [];
      if (!instances.length) return;
      shape.groups.forEach((group, groupIndex) => {
        if (!group.positions?.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        if (group.uvs?.length === (group.positions.length / 3) * 2) {
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
        }
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const material = this.getMaterial(shape.materials[group.materialIndex]);
        const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
        mesh.name = `${shape.fileName}:${groupIndex}`;
        // 场景实例跨越十余公里。若只使用单个源几何体的包围球进行裁剪，
        // 列车驶离车站后远端实例会被误判为不可见，表现为线路后段突然缺失。
        // 当前导出场景仅约2.5万三角形，关闭该组级裁剪的性能代价可控。
        mesh.frustumCulled = false;
        mesh.userData.sourceShape = shape.fileName;
        const object = new THREE.Object3D();
        instances.forEach((instance, index) => {
          object.position.fromArray(instance.position);
          object.quaternion.fromArray(instance.quaternion).normalize();
          object.scale.setScalar(1);
          object.updateMatrix();
          mesh.setMatrixAt(index, object.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        this.routeRoot.add(mesh);
      });
    });
  }

  buildRoutePath(data, sceneData) {
    // 原中心线只包含轨道构件连接点。直接线性插值会在曲线连接处走弦线，
    // 驾驶视点离开站场后看起来会切出钢轨。使用相邻真实 TrackObj 的朝向
    // 构造 Hermite 中心线，并以约5 m间距重采样，使位置和朝向连续贴合线路。
    const alignedPoints = data?.summary?.aligned
      ? Array.from({ length: data.positions.length / 3 }, (_, index) => data.positions.slice(index * 3, index * 3 + 3))
      : buildRailAlignedPath(data.positions, sceneData?.instances, { spacing: 5 });
    this.routePoints = alignedPoints.map((point) => new THREE.Vector3(...point));
    this.routeDistances = cumulativePathDistances(alignedPoints);
    this.pathLength = this.routeDistances[this.routeDistances.length - 1];
  }

  buildPassengerConsist(count = 12) {
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#d9ddda', roughness: 0.68, metalness: 0.22 });
    const bandMaterial = new THREE.MeshStandardMaterial({ color: '#21628c', roughness: 0.72, metalness: 0.12 });
    const windowMaterial = new THREE.MeshStandardMaterial({ color: '#142a39', roughness: 0.22, metalness: 0.15, emissive: '#102b3a', emissiveIntensity: 0.32 });
    const roofMaterial = new THREE.MeshStandardMaterial({ color: '#8e999e', roughness: 0.82, metalness: 0.18 });
    const underframeMaterial = new THREE.MeshStandardMaterial({ color: '#20282b', roughness: 0.88, metalness: 0.35 });
    const doorMaterial = new THREE.MeshStandardMaterial({ color: '#c8cdca', roughness: 0.7, metalness: 0.18 });
    const bodyGeometry = new THREE.BoxGeometry(3.1, 3.55, 24.5);
    const bandGeometry = new THREE.BoxGeometry(3.15, 0.48, 24.55);
    const windowGeometry = new THREE.BoxGeometry(0.055, 0.72, 1.38);
    const roofGeometry = new THREE.BoxGeometry(3.0, 0.28, 24.1);
    const underframeGeometry = new THREE.BoxGeometry(2.7, 0.52, 22.5);
    const doorGeometry = new THREE.BoxGeometry(0.06, 2.35, 1.55);
    const doorWindowGeometry = new THREE.BoxGeometry(0.065, 0.62, 0.74);
    const bogieGeometry = new THREE.BoxGeometry(2.72, 0.55, 3.0);
    for (let index = 0; index < count; index += 1) {
      const car = new THREE.Group();
      car.name = `PASSENGER_CAR_${String(index + 1).padStart(2, '0')}`;
      const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
      body.position.y = 2.45;
      car.add(body);
      const band = new THREE.Mesh(bandGeometry, bandMaterial);
      band.position.y = 1.65;
      car.add(band);
      for (const side of [-1, 1]) {
        for (let windowIndex = 0; windowIndex < 10; windowIndex += 1) {
          const window = new THREE.Mesh(windowGeometry, windowMaterial);
          window.position.set(side * 1.57, 2.85, -9.2 + windowIndex * 2.05);
          car.add(window);
        }
        for (const doorZ of [-11.25, 11.25]) {
          const door = new THREE.Mesh(doorGeometry, doorMaterial);
          door.position.set(side * 1.575, 2.12, doorZ);
          car.add(door);
          const doorWindow = new THREE.Mesh(doorWindowGeometry, windowMaterial);
          doorWindow.position.set(side * 1.61, 2.76, doorZ);
          car.add(doorWindow);
        }
      }
      const roof = new THREE.Mesh(roofGeometry, roofMaterial);
      roof.position.y = 4.34;
      car.add(roof);
      const underframe = new THREE.Mesh(underframeGeometry, underframeMaterial);
      underframe.position.y = 0.55;
      car.add(underframe);
      for (const bogieZ of [-7.7, 7.7]) {
        const bogie = new THREE.Mesh(bogieGeometry, underframeMaterial);
        bogie.position.set(0, 0.22, bogieZ);
        car.add(bogie);
      }
      // 以司机视点为列车前端参考。HXD1C 车体与连挂间距计入首辆客车中心距，
      // 避免后部瞭望镜头落入第一辆客车端面。
      car.userData.trainOffset = 33 + index * 25.8;
      car.userData.consistIndex = index;
      car.userData.consistCount = count;
      this.routeRoot.add(car);
      this.passengerCars.push(car);
    }
    this.updatePassengerConsist();
  }

  getExtendedPathPosition(distance, target = new THREE.Vector3()) {
    if (distance >= 0) return this.getPathPosition(distance, target);
    if (this.routePoints.length < 2) return target.set(0, 0, -distance);
    const origin = this.routePoints[0];
    const tangent = new THREE.Vector3().subVectors(this.routePoints[1], origin).normalize();
    return target.copy(origin).addScaledVector(tangent, distance);
  }

  getExtendedPathTangent(distance, target = new THREE.Vector3()) {
    const before = this.getExtendedPathPosition(distance - 1.5, new THREE.Vector3());
    const after = this.getExtendedPathPosition(distance + 1.5, new THREE.Vector3());
    target.subVectors(after, before);
    target.y = 0;
    if (target.lengthSq() < 0.000001) target.set(0, 0, -1);
    return target.normalize();
  }

  updatePassengerConsist(startFraction = this.wholeTrainStartFraction ?? 1) {
    if (!this.passengerCars.length) return;
    const now = performance.now() / 1000;
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const lateral = new THREE.Vector3();
    this.passengerCars.forEach((car) => {
      // 起动初段按车钩力由前向后传播。每辆车达到自己的传播阈值后才开始
      // 跟随机车移动；全列起动后所有车辆恢复正常等距跟随。
      const count = Math.max(1, car.userData.consistCount || this.passengerCars.length);
      const index = car.userData.consistIndex || 0;
      const movementRatio = THREE.MathUtils.clamp(startFraction * count - index, 0, 1);
      const previousRatio = car.userData.lastMovementRatio || 0;
      if (movementRatio > 0.025 && previousRatio <= 0.025) car.userData.startPulseAt = now;
      if (movementRatio <= 0.001 && previousRatio > 0.001) car.userData.startPulseAt = null;
      car.userData.lastMovementRatio = movementRatio;
      const pulseAge = car.userData.startPulseAt == null ? 99 : Math.max(0, now - car.userData.startPulseAt);
      const pulse = Math.exp(-2.45 * pulseAge);
      // 车钩间隙被拉紧后产生一次很轻的纵向顿动，并伴随客车车体的微小横摇。
      // 使用确定性的阻尼正弦，不使用随机抖动，避免课堂画面像渲染故障。
      const longitudinalSlack = Math.sin(pulseAge * 10.5 + index * 0.18) * 0.045 * pulse;
      const lateralSway = Math.sin(pulseAge * 6.4 + index * 0.52) * 0.022 * pulse;
      const routeDistance = this.startOffset + this.distance * movementRatio;
      const carDistance = routeDistance - car.userData.trainOffset + longitudinalSlack;
      this.getExtendedPathPosition(carDistance, point);
      this.getExtendedPathTangent(carDistance, tangent);
      car.position.copy(point);
      lateral.set(tangent.z, 0, -tangent.x);
      car.position.addScaledVector(lateral, lateralSway);
      car.rotation.set(
        Math.sin(pulseAge * 7.2 + index * 0.28) * 0.0024 * pulse,
        Math.atan2(tangent.x, tangent.z),
        Math.sin(pulseAge * 6.4 + index * 0.52) * 0.0042 * pulse,
      );
    });
  }

  projectPointToPath(position, maximumDistance = this.pathLength) {
    const target = new THREE.Vector3().fromArray(position);
    const closest = new THREE.Vector3();
    const segment = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    let best = null;
    for (let index = 1; index < this.routePoints.length; index += 1) {
      if (this.routeDistances[index - 1] > maximumDistance) break;
      const start = this.routePoints[index - 1];
      const end = this.routePoints[index];
      segment.subVectors(end, start);
      const lengthSq = segment.lengthSq();
      if (lengthSq < 0.000001) continue;
      const ratio = THREE.MathUtils.clamp(offset.subVectors(target, start).dot(segment) / lengthSq, 0, 1);
      closest.copy(start).addScaledVector(segment, ratio);
      const distance = closest.distanceTo(target);
      if (!best || distance < best.lateralDistance) {
        tangent.copy(segment);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) continue;
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const relative = new THREE.Vector3().subVectors(target, closest);
        best = {
          alongDistance: this.routeDistances[index - 1] + Math.sqrt(lengthSq) * ratio,
          lateralDistance: distance,
          signedLateral: relative.dot(right),
          verticalOffset: relative.y,
          point: closest.clone(),
          tangent: tangent.clone(),
        };
      }
    }
    return best;
  }

  buildRailHighlights(maxDistance, gapConfig = null) {
    const count = this.routePoints.findIndex((_, index) => this.routeDistances[index] > maxDistance);
    const pointCount = count === -1 ? this.routePoints.length : Math.max(2, count + 1);
    const material = new THREE.MeshPhysicalMaterial({
      color: '#c9d2d7',
      metalness: 0.96,
      roughness: 0.13,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      emissive: '#303a40',
      emissiveIntensity: 0.34,
      side: THREE.DoubleSide,
    });
    const glintMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const glintRoot = new THREE.Group();
    glintRoot.name = 'LOOKOUT_RAIL_GLINT';
    const gaugeHalf = 0.7175;
    const railHalfWidth = 0.036;
    for (const railOffset of [-gaugeHalf, gaugeHalf]) {
      const positions = [];
      const normals = [];
      const indices = [];
      for (let index = 0; index < pointCount; index += 1) {
        const point = this.routePoints[index];
        const previous = this.routePoints[Math.max(0, index - 1)];
        const next = this.routePoints[Math.min(pointCount - 1, index + 1)];
        const tangent = new THREE.Vector3().subVectors(next, previous);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const center = point.clone().addScaledVector(right, railOffset);
        center.y += 0.045;
        const edgeA = center.clone().addScaledVector(right, -railHalfWidth);
        const edgeB = center.clone().addScaledVector(right, railHalfWidth);
        positions.push(edgeA.x, edgeA.y, edgeA.z, edgeB.x, edgeB.y, edgeB.z);
        normals.push(0, 1, 0, 0, 1, 0);
        if (index < pointCount - 1) {
          const base = index * 2;
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const rail = new THREE.Mesh(geometry, material);
      rail.name = railOffset < 0 ? 'SELECTED_ROUTE_RAIL_LEFT' : 'SELECTED_ROUTE_RAIL_RIGHT';
      this.routeRoot.add(rail);

      const glintPositions = [];
      const glintIndices = [];
      const glintHalfWidth = 0.024;
      const gapStart = gapConfig ? gapConfig.hazardDistance - 38 : Number.POSITIVE_INFINITY;
      const gapEnd = gapConfig ? gapConfig.hazardDistance + 38 : Number.NEGATIVE_INFINITY;
      for (let index = 0; index < pointCount; index += 1) {
        const point = this.routePoints[index];
        const previous = this.routePoints[Math.max(0, index - 1)];
        const next = this.routePoints[Math.min(pointCount - 1, index + 1)];
        const tangent = new THREE.Vector3().subVectors(next, previous);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const innerEdge = railOffset - Math.sign(railOffset) * 0.016;
        const center = point.clone().addScaledVector(right, innerEdge);
        center.y += 0.088;
        const edgeA = center.clone().addScaledVector(right, -glintHalfWidth);
        const edgeB = center.clone().addScaledVector(right, glintHalfWidth);
        glintPositions.push(edgeA.x, edgeA.y, edgeA.z, edgeB.x, edgeB.y, edgeB.z);
        if (index < pointCount - 1) {
          const base = index * 2;
          const segmentStart = this.routeDistances[index];
          const segmentEnd = this.routeDistances[index + 1];
          if (segmentEnd < gapStart || segmentStart > gapEnd) {
            glintIndices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          }
        }
      }
      const glintGeometry = new THREE.BufferGeometry();
      glintGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glintPositions, 3));
      glintGeometry.setIndex(glintIndices);
      glintGeometry.computeBoundingSphere();
      const glint = new THREE.Mesh(glintGeometry, glintMaterial);
      glint.name = railOffset < 0 ? 'SELECTED_ROUTE_GLINT_LEFT' : 'SELECTED_ROUTE_GLINT_RIGHT';
      glint.renderOrder = 3;
      glint.frustumCulled = false;
      glintRoot.add(glint);
    }
    this.routeRoot.add(glintRoot);
    this.lookoutVisuals.railGlint = glintRoot;
  }

  buildContinuousRailHeads(maxDistance, minDistance = 0) {
    // “钢轨反光中断”只属于途中瞭望考核。过分相项目若复用该缺口，会在
    // 4600–4780 m之间丢失远景轨顶LOD，看起来像近、远钢轨突然合拢断开。
    const railEvent = this.isLookout
      ? LOOKOUT_TRAINING_CONFIG.events.find((item) => item.visualKind === 'rail')
      : null;
    // 正常反光在评分危险边界处突然终止，后续180 m保持暗哑。
    // 这样学生从约400 m外看到的视觉边界，与必须停车的位置一致。
    const gapStart = railEvent
      ? Math.max(minDistance, Number(railEvent.hazardDistance || 0))
      : maxDistance;
    const gapEnd = railEvent
      ? Math.min(maxDistance, Number(railEvent.glintBreakEndDistance || gapStart + 180))
      : maxDistance;
    // 连续运行线保持 TrackDB 对齐，但轨腰、轨顶尺寸和纹理取自原游戏
    // A1t100mStrt：轨宽 0.15 m、轨腰高 0.125 m、ACleanTrack2 纹理。
    const railBodyMaterial = this.getMaterial({
      name: 'RailSide',
      texture: 'ACleanTrack2.png',
      alphaTestMode: 0,
    }).clone();
    railBodyMaterial.color.set('#737c80');
    railBodyMaterial.metalness = 0.28;
    railBodyMaterial.roughness = 0.5;
    railBodyMaterial.fog = false;
    railBodyMaterial.name = 'LOOKOUT_RAIL_STEEL_BODY';
    const polishedMaterial = this.getMaterial({
      name: 'RailTops',
      texture: 'ACleanTrack2.png',
      alphaTestMode: 0,
    }).clone();
    // 此场景没有环境贴图，金属度过高会把正常钢轨渲染成黑色。
    polishedMaterial.color.set('#a9b2b5');
    polishedMaterial.metalness = 0.42;
    polishedMaterial.roughness = 0.28;
    polishedMaterial.clearcoat = 0.35;
    polishedMaterial.clearcoatRoughness = 0.22;
    polishedMaterial.emissive.set('#000000');
    polishedMaterial.emissiveIntensity = 0;
    polishedMaterial.fog = false;
    polishedMaterial.polygonOffset = true;
    polishedMaterial.polygonOffsetFactor = -1;
    polishedMaterial.polygonOffsetUnits = -3;
    polishedMaterial.name = 'LOOKOUT_POLISHED_RAIL_STEEL';
    // 异常段钢轨实体仍然存在，但轨面不参与环境高光计算，避免主光源把“中断”重新照亮。
    const dullMaterial = new THREE.MeshBasicMaterial({ color: '#07090a', toneMapped: true, fog: false });
    dullMaterial.name = 'LOOKOUT_DULL_RAIL_STEEL';
    const gaugeHalf = 0.7175;
    // 默认尺寸仅作回退；本务线调用使用原模型实测的 0.15 m 轨宽与 0.125 m 轨腰高度。
    const halfWidth = 0.06;
    const baseHeight = 0.18;
    const railHeight = 0.15;
    const railRoot = new THREE.Group();
    railRoot.name = 'LOOKOUT_CONTINUOUS_SOURCE_STYLE_RAILS';
    railRoot.userData.generatedAtLoad = true;
    railRoot.userData.source = 'NEIYI TrackDB rail-aligned path';
    railRoot.userData.startDistance = minDistance;
    railRoot.userData.endDistance = maxDistance;
    railRoot.userData.distanceLimited = false;
    railRoot.userData.fogLimited = false;

    const buildRailSection = (railOffset, startDistance, endDistance, material, suffix, dimensions = {}) => {
      if (endDistance - startDistance < 0.5) return;
      const sectionHalfWidth = dimensions.halfWidth ?? halfWidth;
      const sectionBaseHeight = dimensions.baseHeight ?? baseHeight;
      const sectionHeight = dimensions.railHeight ?? railHeight;
      const positions = [];
      const uvs = [];
      const indices = [];
      const sampleDistances = [];
      for (let distance = startDistance; distance < endDistance; distance += 4) sampleDistances.push(distance);
      sampleDistances.push(endDistance);
      sampleDistances.forEach((distance, index) => {
        const { point, right, up } = this.getLookoutPathFrame3D(distance);
        const center = point.clone().addScaledVector(right, railOffset).addScaledVector(up, sectionBaseHeight);
        const bottomLeft = center.clone().addScaledVector(right, -sectionHalfWidth);
        const bottomRight = center.clone().addScaledVector(right, sectionHalfWidth);
        const topLeft = bottomLeft.clone().addScaledVector(up, sectionHeight);
        const topRight = bottomRight.clone().addScaledVector(up, sectionHeight);
        positions.push(
          bottomLeft.x, bottomLeft.y, bottomLeft.z,
          bottomRight.x, bottomRight.y, bottomRight.z,
          topLeft.x, topLeft.y, topLeft.z,
          topRight.x, topRight.y, topRight.z,
        );
        if (dimensions.uvMode === 'rail-side') {
          const u = distance / 14.5;
          uvs.push(u, 0.001, u, 0.001, u, 0.07, u, 0.07);
        } else if (dimensions.uvMode === 'rail-top') {
          const u = distance / 5;
          uvs.push(u, 0.133, u, 0.227, u, 0.133, u, 0.227);
        }
        if (index > 0) {
          const previousBase = (index - 1) * 4;
          const currentBase = index * 4;
          indices.push(
            previousBase, currentBase, previousBase + 2,
            previousBase + 2, currentBase, currentBase + 2,
            previousBase + 1, previousBase + 3, currentBase + 1,
            previousBase + 3, currentBase + 3, currentBase + 1,
            previousBase + 2, currentBase + 2, previousBase + 3,
            previousBase + 3, currentBase + 2, currentBase + 3,
          );
        }
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      if (uvs.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const rail = new THREE.Mesh(geometry, material);
      rail.name = `LOOKOUT_RAIL_${railOffset < 0 ? 'LEFT' : 'RIGHT'}_${suffix}`;
      rail.frustumCulled = false;
      railRoot.add(rail);
    };

    // 实体钢轨贯通全线。只在轨顶中心叠加 WebGL 原生 1 px 银灰线；
    // 不再使用屏幕空间加宽三角带，避免近远景交界处鼓包、突出或合拢。
    const buildFarVisibilitySection = (railOffset, startDistance, endDistance, suffix) => {
      if (endDistance - startDistance < 1) return;
      const distances = [];
      for (let distance = startDistance; distance < endDistance; distance += 4) distances.push(distance);
      distances.push(endDistance);
      const positions = [];
      distances.forEach((distance) => {
        const { point, right, up } = this.getLookoutPathFrame3D(distance);
        const center = point.clone().addScaledVector(right, railOffset).addScaledVector(up, 0.341);
        positions.push(center.x, center.y, center.z);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeBoundingSphere();
      const material = new THREE.LineBasicMaterial({
        color: '#a9b2b5', transparent: true, opacity: 0.86,
        depthWrite: false, depthTest: true, fog: false, toneMapped: false,
      });
      material.name = 'LOOKOUT_DISTANT_RAIL_METAL_LINE_MATERIAL';
      this.railVisibilityMaterials.push(material);
      const line = new THREE.Line(geometry, material);
      line.name = `MAINLINE_RAIL_VISIBILITY_METAL_${railOffset < 0 ? 'LEFT' : 'RIGHT'}_${suffix}`;
      line.frustumCulled = false;
      line.renderOrder = 6;
      line.userData.layer = 'metal-continuity';
      line.userData.startDistance = startDistance;
      line.userData.endDistance = endDistance;
      farVisibilityRoot.add(line);
    };

    const farVisibilityRoot = new THREE.Group();
    farVisibilityRoot.name = 'LOOKOUT_MAINLINE_RAIL_VISIBILITY_LOD';
    farVisibilityRoot.userData.source = 'native one-pixel metal continuity line over complete 3D rail heads';
    farVisibilityRoot.userData.startDistance = minDistance;
    farVisibilityRoot.userData.endDistance = maxDistance;
    farVisibilityRoot.userData.distanceLimited = false;
    farVisibilityRoot.userData.fogLimited = false;

    for (const railOffset of [-gaugeHalf, gaugeHalf]) {
      // 钢轨本体贯通全线，反光异常只改变顶面材质，不制造真实断轨或接缝。
      buildRailSection(railOffset, minDistance, maxDistance, railBodyMaterial, 'BODY', {
        halfWidth: 0.075,
        baseHeight: 0.2,
        railHeight: 0.125,
        uvMode: 'rail-side',
      });
      buildRailSection(railOffset, minDistance, gapStart, polishedMaterial, 'POLISHED_BEFORE', {
        halfWidth: 0.075,
        baseHeight: 0.325,
        railHeight: 0.008,
        uvMode: 'rail-top',
      });
      buildRailSection(railOffset, gapStart, gapEnd, dullMaterial, 'GLINT_BREAK', {
        halfWidth: 0.075,
        baseHeight: 0.325,
        railHeight: 0.008,
      });
      buildRailSection(railOffset, gapEnd, maxDistance, polishedMaterial, 'POLISHED_AFTER', {
        halfWidth: 0.075,
        baseHeight: 0.325,
        railHeight: 0.008,
        uvMode: 'rail-top',
      });
      buildFarVisibilitySection(railOffset, minDistance, gapStart, 'BEFORE_GLINT_BREAK');
      buildFarVisibilitySection(railOffset, gapEnd, maxDistance, 'AFTER_GLINT_BREAK');
    }
    this.routeRoot.add(railRoot);
    this.routeRoot.add(farVisibilityRoot);
    this.lookoutVisuals.railGlint = railRoot;
    this.lookoutVisuals.railVisibilityLod = farVisibilityRoot;
  }

  buildSelectedRouteTrack(maxDistance, minDistance = 0) {
    const firstMatch = this.routeDistances.findIndex((distance) => distance >= minDistance);
    const startIndex = Math.max(0, firstMatch === -1 ? 0 : firstMatch - 1);
    const endMatch = this.routeDistances.findIndex((distance) => distance > maxDistance);
    const endIndex = endMatch === -1 ? this.routePoints.length - 1 : Math.min(this.routePoints.length - 1, endMatch);
    const pointCount = Math.max(2, endIndex - startIndex + 1);
    const ribbon = (halfWidth, yOffset, material, name, textured = false) => {
      const positions = [];
      const normals = [];
      const uvs = [];
      const indices = [];
      for (let index = 0; index < pointCount; index += 1) {
        const routeIndex = Math.min(endIndex, startIndex + index);
        const point = this.routePoints[routeIndex];
        const previous = this.routePoints[Math.max(0, routeIndex - 1)];
        const next = this.routePoints[Math.min(this.routePoints.length - 1, routeIndex + 1)];
        const tangent = new THREE.Vector3().subVectors(next, previous);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const center = point.clone();
        center.y += yOffset;
        const left = center.clone().addScaledVector(right, -halfWidth);
        const rightEdge = center.clone().addScaledVector(right, halfWidth);
        positions.push(left.x, left.y, left.z, rightEdge.x, rightEdge.y, rightEdge.z);
        normals.push(0, 1, 0, 0, 1, 0);
        if (textured) {
          const repeat = this.routeDistances[routeIndex] / 6.56;
          uvs.push(0, repeat, 1, repeat);
        }
        if (index < pointCount - 1) {
          const base = index * 2;
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      if (textured) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.userData.generatedAtLoad = true;
      mesh.userData.startDistance = minDistance;
      mesh.userData.endDistance = maxDistance;
      this.routeRoot.add(mesh);
    };

    ribbon(2.52, -0.045, new THREE.MeshStandardMaterial({
      color: '#625f57', roughness: 1, metalness: 0, side: THREE.DoubleSide,
    }), 'SELECTED_ROUTE_BALLAST_SHOULDER');
    const trackMaterial = this.getMaterial({
      name: 'MSTS_SELECTED_ROUTE_TRACK',
      texture: 'ACleanTrack1.png',
      alphaTestMode: 0,
    }).clone();
    trackMaterial.roughness = 0.72;
    trackMaterial.metalness = 0.12;
    trackMaterial.polygonOffset = true;
    trackMaterial.polygonOffsetFactor = -2;
    trackMaterial.polygonOffsetUnits = -2;
    ribbon(2.24, 0.008, trackMaterial, 'SELECTED_ROUTE_TEXTURED_TRACK', true);
  }

  buildSourceDepartureSignal(data) {
    // 使用当前课堂线路中的两架矮型出站信号机，统一作为株洲站1道发车场景。
    const selectSignal = (uid, expectedDistance) => {
      const candidates = data.instances
        .filter((item) => item.uid === uid && item.type === 'SignalObj' && item.shape === 'chuzhan-halfauto-zhuci.s')
        .map((instance) => ({ instance, projection: this.projectPointToPath(instance.position) }))
        .filter(({ projection }) => projection)
        .sort((a, b) => Math.abs(a.projection.alongDistance - expectedDistance) - Math.abs(b.projection.alongDistance - expectedDistance));
      return candidates[0] || null;
    };
    const departure = selectSignal(ROUTE_CONTEXT.departureSignalSourceUid, ROUTE_CONTEXT.departureSignalExpectedDistance);
    const neighbor = selectSignal(ROUTE_CONTEXT.neighborSignalSourceUid, ROUTE_CONTEXT.neighborSignalExpectedDistance);
    if (!departure || !neighbor) {
      this.error = new Error('未找到原发车作业场景中配置的两架矮型出站信号机。');
      return;
    }

    const signalShape = data.shapes['chuzhan-halfauto-zhuci.s'];
    if (!signalShape || !Array.isArray(signalShape.groups) || !Array.isArray(signalShape.materials)) {
      this.error = new Error('原发车作业场景出站信号机模型数据无效。');
      return;
    }

    const signalAsset = {
      source: { fileName: signalShape.fileName, sha256: signalShape.sha256 || '' },
      materials: signalShape.materials,
      groups: signalShape.groups,
    };
    // 信号机本体和位置来自原场景，灯态由网页课堂层控制。
    this.departureSignal = this.createSourceSignal(departure, signalAsset, 'SOURCE_DWARF_DEPARTURE_SIGNAL', true);
    this.neighborSignal = this.createSourceSignal(neighbor, signalAsset, 'SOURCE_DWARF_NEIGHBOR_SIGNAL', false);
    this.setDepartureSignalAspect(this.signalAspect);
  }

  createSignalGlowTexture() {
    if (this.signalGlowTexture) return this.signalGlowTexture;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.23, 'rgba(255,255,255,.95)');
    gradient.addColorStop(0.52, 'rgba(255,255,255,.42)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    this.signalGlowTexture = new THREE.CanvasTexture(canvas);
    this.signalGlowTexture.colorSpace = THREE.SRGBColorSpace;
    return this.signalGlowTexture;
  }

  createSourceSignal(selected, signalAsset, name, isDepartureSignal, includeBody = false) {
    const root = new THREE.Group();
    root.name = name;
    root.position.fromArray(selected.instance.position);
    root.quaternion.fromArray(selected.instance.quaternion).normalize();
    root.userData.isDepartureSignal = isDepartureSignal;
    root.userData.sourceUid = selected.instance.uid;
    root.userData.sourceShape = selected.instance.shape;
    root.userData.alongDistance = selected.projection.alongDistance;
    root.userData.signedLateral = selected.projection.signedLateral;

    const visual = new THREE.Group();
    visual.name = `${name}_VISUAL`;
    root.add(visual);
    const body = new THREE.Group();
    body.name = `${name}_BODY`;
    if (includeBody) {
      signalAsset.groups.forEach((group, groupIndex) => {
        if (!group.positions?.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        if (group.uvs?.length === (group.positions.length / 3) * 2) {
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
        }
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, this.getMaterial(signalAsset.materials[group.materialIndex]));
        mesh.name = `${name}_BODY_${groupIndex}`;
        mesh.userData.sourceShape = signalAsset.source.fileName;
        mesh.userData.sourceSha256 = signalAsset.source.sha256;
        body.add(mesh);
      });
    }
    visual.add(body);

    const lampGeometry = new THREE.SphereGeometry(0.095, 14, 10);
    const lampDefinitions = {
      red: [-0.243, 0.49, 0.025],
      greenLower: [0.01, 0.49, 0.025],
      yellow: [0.01, 0.698, 0.025],
      green: [0.01, 0.911, 0.035],
    };
    const lamps = {};
    const lampMeshes = [];
    const glowSprites = [];
    for (const [lampName, position] of Object.entries(lampDefinitions)) {
      const lensMaterial = new THREE.MeshBasicMaterial({ color: '#121617', transparent: true, opacity: 0.72, toneMapped: false });
      const lamp = new THREE.Mesh(lampGeometry, lensMaterial);
      lamp.name = `SOURCE_SIGNAL_${lampName.toUpperCase()}`;
      lamp.position.fromArray(position);
      visual.add(lamp);
      const glowMaterial = new THREE.SpriteMaterial({
        map: this.createSignalGlowTexture(),
        color: '#121617',
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const glow = new THREE.Sprite(glowMaterial);
      glow.name = `${lamp.name}_GLOW`;
      glow.position.copy(lamp.position);
      glow.userData.basePosition = lamp.position.clone();
      glow.renderOrder = 8;
      root.add(glow);
      lamps[lampName] = { lensMaterial, glowMaterial };
      lampMeshes.push(lamp);
      glowSprites.push(glow);
    }
    this.routeRoot.add(root);
    return { root, visual, body, lamps, lampMeshes, glowSprites, projection: selected.projection };
  }

  setDepartureSignalAspect(aspect) {
    this.signalAspect = aspect || 'green';
    this.applySignalAspect(this.departureSignal, this.signalAspect);
    // 邻线信号机固定显示红灯，明确其不属于本列车运行进路。
    this.applySignalAspect(this.neighborSignal, 'red');
  }

  buildSourceRouteSignalLights(data) {
    // 灯位来自 NEIYI/sigcfg.dat；杆体、信号机头和姿态仍使用原游戏 SignalObj。
    const definitions = Object.freeze({
      'jinzhan-yugao.s': { green: [0, 5.543, 0], yellow: [0, 5.343, 0], radius: 0.14 },
      // 灯位直接取自京广线路 sigcfg.dat 的 CHINAjinzhanLight。
      'jinzhan.s': { green: [0, 5.026, 0], yellow: [0, 5.331, 0], red: [0, 4.113, 0], radius: 0.115 },
      'chuzhan-halfauto.s': { green: [0.01, 0.944, 0], red: [0.01, 0.742, 0], radius: 0.09 },
      'jinzhan-fushi.s': { green: [0.01, 0.762, 0], radius: 0.09 },
      'chuzhan-fushi.s': { green: [0.01, 0.762, 0], radius: 0.09 },
    });
    const colors = { green: '#28e878', yellow: '#f6c744', red: '#e54a46' };
    const routeSignals = [];
    const signalWindowStart = this.isTerminalStation ? Number(this.routeWindow?.start) || 0 : 0;
    const signalWindowEnd = this.isTerminalStation
      ? Number(this.routeWindow?.end) || this.pathLength
      : LOOKOUT_TRAINING_CONFIG.finishDistance + 500;
    for (const instance of data.instances) {
      const definition = definitions[instance.shape];
      if (instance.type !== 'SignalObj' || !definition) continue;
      const projection = this.projectPointToPath(instance.position);
      if (!projection
        || projection.alongDistance < signalWindowStart
        || projection.alongDistance > signalWindowEnd) continue;
      if (projection.lateralDistance > 8.5) continue;
      const overlapsDeparture = [this.departureSignal, this.neighborSignal].some((signal) => (
        signal && Math.abs(signal.projection.alongDistance - projection.alongDistance) < 1.5
      ));
      if (overlapsDeparture) continue;

      const terminalStopSignal = this.isTerminalStation
        && Math.abs(projection.alongDistance - Number(this.routeWindow?.redSignalDistance)) < 24;
      const terminalEntrySignal = this.isTerminalStation
        && Math.abs(projection.alongDistance - Number(this.routeWindow?.entrySignalDistance)) < 24;
      const aspect = terminalStopSignal
        ? 'red'
        : terminalEntrySignal && definition.yellow ? 'yellow'
        : Math.abs(projection.signedLateral) <= 4.8 || !definition.red ? 'green' : 'red';
      const localPosition = definition[aspect] || definition.green;
      const root = new THREE.Group();
      root.name = `SOURCE_ROUTE_SIGNAL_LIGHT_${String(routeSignals.length + 1).padStart(2, '0')}`;
      root.position.fromArray(instance.position);
      root.quaternion.fromArray(instance.quaternion).normalize();
      root.userData.sourceUid = instance.uid;
      root.userData.sourceShape = instance.shape;
      root.userData.alongDistance = projection.alongDistance;
      root.userData.aspect = aspect;
      const visual = new THREE.Group();
      root.add(visual);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(definition.radius, 14, 10),
        new THREE.MeshBasicMaterial({ color: colors[aspect], toneMapped: false }),
      );
      lamp.position.fromArray(localPosition);
      visual.add(lamp);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.createSignalGlowTexture(),
        color: colors[aspect],
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false,
      }));
      glow.position.copy(lamp.position);
      glow.userData.basePosition = lamp.position.clone();
      glow.scale.setScalar(definition.radius * 4.5);
      glow.renderOrder = 8;
      visual.add(glow);
      this.routeRoot.add(root);
      routeSignals.push({ root, visual, glowSprites: [glow], projection, instance, aspect });
    }
    this.routeSignalLights = routeSignals;
    if (this.isTerminalStation) {
      this.throughSignal = null;
      return;
    }
    const throughTarget = LOOKOUT_TRAINING_CONFIG.continuityEndDistance + 350;
    this.throughSignal = routeSignals
      .filter((signal) => signal.instance.shape === 'jinzhan-yugao.s')
      .sort((a, b) => Math.abs(a.projection.alongDistance - throughTarget) - Math.abs(b.projection.alongDistance - throughTarget))[0] || null;
  }

  buildTeachingThroughSignals(repairAssetData) {
    const configuredSignals = LOOKOUT_TRAINING_CONFIG.throughSignals || [
      { id: '2328', distance: LOOKOUT_TRAINING_CONFIG.throughSignalDistance },
    ];
    this.throughSignals = [];
    for (const configuredSignal of configuredSignals) {
      const distance = Number(configuredSignal.distance);
      if (!distance || distance >= this.pathLength) continue;
      const signalId = String(configuredSignal.id || this.throughSignals.length + 1);
      const root = new THREE.Group();
      root.name = `TEACHING_${signalId}_THROUGH_SIGNAL`;
      root.userData.signalId = signalId;
      this.placeLookoutObject3D(root, distance, 3.6, 0);
      // 使用原游戏京广线路的 tongguo.s，而不是把进站预告信号机误作通过信号机。
      const body = this.createSourceShapeObject(repairAssetData, 'tongguo.s', `SOURCE_TONGGUO_SIGNAL_BODY_${signalId}`);
      if (!body) throw new Error('原游戏通过信号机模型数据无效。');
      root.add(body);

      // 灯位和半径直接取自原线路 sigcfg.dat 的 CHINAtongguoLight。
      const lampGeometry = new THREE.SphereGeometry(.115, 16, 12);
      const lamps = {};
      const glowSprites = [];
      const lampDefinitions = { green: 5.548, yellow: 4.963, red: 5.255 };
      for (const [name, y] of Object.entries(lampDefinitions)) {
        const on = name === 'green';
        const color = { green: '#28e878', yellow: '#f6c744', red: '#e54a46' }[name];
        const material = new THREE.MeshBasicMaterial({ color: on ? color : '#121617', toneMapped: false });
        const lamp = new THREE.Mesh(lampGeometry, material);
        lamp.position.set(0, y, -0.02);
        root.add(lamp);
        const glowMaterial = new THREE.SpriteMaterial({
          map: this.createSignalGlowTexture(),
          color,
          transparent: true,
          opacity: on ? 0.94 : 0,
          depthWrite: false,
          toneMapped: false,
        });
        const glow = new THREE.Sprite(glowMaterial);
        glow.position.copy(lamp.position);
        glow.userData.basePosition = lamp.position.clone();
        glow.renderOrder = 8;
        root.add(glow);
        glowSprites.push(glow);
        lamps[name] = { lensMaterial: material, glowMaterial };
      }
      this.routeRoot.add(root);
      const signal = { root, visual: root, body, lamps, lampMeshes: [], glowSprites, projection: { alongDistance: distance } };
      this.throughSignals.push(signal);
      this.applySignalAspect(signal, 'green');
    }
    this.throughSignal = this.throughSignals[0] || null;
  }

  applySignalAspect(signal, aspect) {
    if (!signal) return;
    const active = {
      green: ['green'],
      greenYellow: ['greenLower', 'yellow'],
      yellow: ['yellow'],
      red: ['red'],
    }[aspect] || [];
    const colors = { green: '#28e878', greenLower: '#28e878', yellow: '#f6c744', red: '#e54a46' };
    for (const [name, materials] of Object.entries(signal.lamps)) {
      const on = active.includes(name);
      materials.lensMaterial.color.set(on ? colors[name] : '#121617');
      materials.lensMaterial.opacity = on ? this.signalLampVisibility : Math.min(0.72, this.signalLampVisibility * 0.72);
      materials.glowMaterial.color.set(on ? colors[name] : '#121617');
      materials.glowMaterial.opacity = on ? this.signalLampVisibility * 0.94 : 0;
    }
  }

  updateSignalTeachingVisibility() {
    const teachingSignals = this.throughSignals.length ? this.throughSignals : [this.throughSignal];
    for (const signal of [this.departureSignal, this.neighborSignal, ...teachingSignals]) {
      if (!signal) continue;
      const head = signal.root.localToWorld(new THREE.Vector3(0, 0.70, 0));
      const distance = this.camera.position.distanceTo(head);
      // 保留原游戏信号机和灯位的真实比例。远距只轻微增加光晕，
      // 不再放大信号机本体或灯位，避免产生“假信号机”观感。
      signal.visual.scale.setScalar(1);
      const glowSize = THREE.MathUtils.clamp(distance * 0.0022, 0.14, 0.65);
      signal.glowSprites.forEach((glow) => {
        glow.position.copy(glow.userData.basePosition);
        glow.scale.setScalar(glowSize);
      });
    }
  }

  getLookoutPathFrame(distance) {
    const point = this.getPathPosition(distance);
    const before = this.getPathPosition(Math.max(0, distance - 3));
    const after = this.getPathPosition(Math.min(this.pathLength, distance + 3));
    const tangent = after.sub(before).setY(0);
    if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
    tangent.normalize();
    return { point, tangent, right: new THREE.Vector3(tangent.z, 0, -tangent.x).normalize() };
  }

  getLookoutPathFrame3D(distance) {
    const point = this.getPathPosition(distance);
    const before = this.getPathPosition(Math.max(0, distance - 3));
    const after = this.getPathPosition(Math.min(this.pathLength, distance + 6));
    const forward = after.sub(before);
    if (forward.lengthSq() < 0.000001) forward.copy(this.forward);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();
    const rotation = new THREE.Matrix4().makeBasis(right, up, forward);
    return { point, forward, right, up, quaternion: new THREE.Quaternion().setFromRotationMatrix(rotation) };
  }

  placeLookoutObject(object, distance, lateral = 0, vertical = 0) {
    const { point, tangent, right } = this.getLookoutPathFrame(distance);
    object.position.copy(point).addScaledVector(right, lateral);
    object.position.y += vertical;
    object.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);
    object.userData.basePosition = object.position.clone();
    object.userData.right = right;
    return object;
  }

  placeLookoutObject3D(object, distance, lateral = 0, vertical = 0) {
    const { point, right, up, quaternion } = this.getLookoutPathFrame3D(distance);
    object.position.copy(point).addScaledVector(right, lateral).addScaledVector(up, vertical);
    object.quaternion.copy(quaternion);
    object.userData.basePosition = object.position.clone();
    object.userData.right = right;
    return object;
  }

  buildLookoutCatenaryRepairs(sceneData) {
    const distances = [...new Set(this.lookoutCatenaryRepairDistances
      .map((distance) => Math.round(distance * 10) / 10))]
      .sort((a, b) => a - b);
    if (!distances.length) return;
    const root = new THREE.Group();
    root.name = 'LOOKOUT_REALIGNED_CATENARY_MASTS';
    distances.forEach((distance, index) => {
      const mast = this.createSourceShapeObject(sceneData, 'SweGantry1.s', `LOOKOUT_REALIGNED_MAST_${String(index + 1).padStart(2, '0')}`);
      if (!mast) return;
      this.placeLookoutObject3D(mast, distance);
      mast.userData.repairedAtDistance = distance;
      root.add(mast);
    });
    root.userData.repairedCount = root.children.length;
    this.routeRoot.add(root);
  }

  buildSourcePrefab(prefab, distance, name) {
    if (!prefab?.anchor || !prefab?.instances?.length || !prefab?.shapes) return null;
    const root = new THREE.Group();
    root.name = name;
    const targetFrame = this.getLookoutPathFrame3D(distance);
    const sourceAnchorPosition = new THREE.Vector3().fromArray(prefab.anchor.position);
    const sourceAnchorQuaternion = new THREE.Quaternion().fromArray(prefab.anchor.quaternion).normalize();
    root.position.copy(targetFrame.point);
    root.quaternion.copy(targetFrame.quaternion).multiply(sourceAnchorQuaternion.clone().invert());
    for (const instance of prefab.instances) {
      const object = this.createSourceShapeObject(prefab, instance.shape, `${name}_${instance.type}_${instance.uid}`);
      if (!object) continue;
      object.position.fromArray(instance.position).sub(sourceAnchorPosition);
      object.quaternion.fromArray(instance.quaternion).normalize();
      object.userData.sourceUid = instance.uid;
      object.userData.sourceShape = instance.shape;
      root.add(object);
    }
    root.userData.sourceWorldTile = prefab.sourceWorldTile || '';
    root.userData.sourceAnchorUid = prefab.anchor.uid;
    return root;
  }

  buildCrossingInfrastructure(root, intrusion) {
    const roadMaterial = new THREE.MeshStandardMaterial({ color: '#3d4143', roughness: 0.94, metalness: 0.02 });
    const deckMaterial = new THREE.MeshStandardMaterial({ color: '#706d65', roughness: 0.9, metalness: 0.04 });
    const road = new THREE.Mesh(new THREE.BoxGeometry(86, 0.08, 7.2), roadMaterial);
    road.name = 'LOOKOUT_CROSSING_APPROACH_ROAD';
    road.position.y = 0.02;
    root.add(road);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.13, 7.2), deckMaterial);
    deck.name = 'LOOKOUT_CROSSING_DECK';
    deck.position.y = 0.085;
    root.add(deck);
    const laneMaterial = new THREE.MeshBasicMaterial({ color: '#e7c946', toneMapped: false });
    for (const side of [-1, 1]) {
      const laneMark = new THREE.Mesh(new THREE.BoxGeometry(37, 0.018, 0.11), laneMaterial);
      laneMark.name = 'LOOKOUT_CROSSING_ROAD_CENTERLINE';
      laneMark.position.set(side * 23.5, 0.075, 0);
      root.add(laneMark);
    }

    const poleMaterial = new THREE.MeshStandardMaterial({ color: '#e8eceb', roughness: 0.72, metalness: 0.2 });
    const redMaterial = new THREE.MeshBasicMaterial({ color: '#d93b35', toneMapped: false });
    const whiteMaterial = new THREE.MeshBasicMaterial({ color: '#f2f2e9', toneMapped: false });
    const addCrossbuck = (x, z) => {
      const sign = new THREE.Group();
      sign.name = 'LOOKOUT_CROSSING_CROSSBUCK';
      sign.position.set(x, 0, z);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.8, 10), poleMaterial);
      post.position.y = 1.4;
      sign.add(post);
      for (const rotation of [-0.56, 0.56]) {
        const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.08), whiteMaterial);
        board.position.y = 2.55;
        board.rotation.z = rotation;
        sign.add(board);
      }
      root.add(sign);
    };
    addCrossbuck(-8.2, 4.25);
    addCrossbuck(8.2, -4.25);

    const addBarrier = (x, z, direction, raised) => {
      const assembly = new THREE.Group();
      assembly.name = raised ? 'LOOKOUT_CROSSING_BARRIER_RAISED' : 'LOOKOUT_CROSSING_BARRIER_LOWERED';
      assembly.position.set(x, 0, z);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.25, 0.28), poleMaterial);
      post.position.y = 0.625;
      assembly.add(post);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), redMaterial);
      lamp.position.y = 1.28;
      assembly.add(lamp);
      const pivot = new THREE.Group();
      pivot.position.y = 1.15;
      if (raised) pivot.rotation.x = -direction * 1.08;
      const boomLength = 5.7;
      const boom = new THREE.Mesh(new THREE.BoxGeometry(.16,.14,boomLength),whiteMaterial);
      boom.position.z = direction * boomLength * .5;
      pivot.add(boom);
      for (let index = 0; index < 5; index += 1) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(.168,.145,.58),redMaterial);
        stripe.position.z = direction * (.58 + index * 1.16);
        pivot.add(stripe);
      }
      assembly.add(pivot);
      root.add(assembly);
    };
    // 两侧栏杆分别从道路外侧向车道中心展开，不再同向穿出路面。
    addBarrier(-5.8, 3.45, -1, intrusion);
    addBarrier(5.8, -3.45, 1, intrusion);
  }

  buildCrossing(config, prefabData, repairAssetData, intrusion = false) {
    const name = intrusion ? 'LOOKOUT_INTRUSION_CROSSING' : 'LOOKOUT_NORMAL_CROSSING';
    // 原道口预制组合中已含道路、轨道和零散构件，与连续教学线路叠加后
    // 会出现双重路面和方向错位。本场景只保留独立、轨向对齐的道口组合。
    const root = new THREE.Group();
    root.name = name;
    this.placeLookoutObject3D(root, config.hazardDistance);
    this.buildCrossingInfrastructure(root, intrusion);
    this.lookoutRoot.add(root);
    if (intrusion) {
      const hazard = new THREE.Group();hazard.name='LOOKOUT_INTRUSION_ACTORS';
      const vehicle = this.createSourceShapeObject(repairAssetData, 'Car1.s', 'LOOKOUT_SOURCE_SEDAN');
      if (!vehicle) throw new Error('原游戏轿车模型数据无效。');
      // Car1.s 的车头朝局部 -Z；旋转后使车头与从左向右的 +X 运动方向一致。
      vehicle.rotation.y = -Math.PI / 2;
      vehicle.position.set(-24, 0.16, 0.12);
      hazard.add(vehicle);
      const person = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(.26,.85,5,10),new THREE.MeshStandardMaterial({color:'#334c62',roughness:.78}));body.position.y=1.05;person.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(.22,12,10),new THREE.MeshStandardMaterial({color:'#d5a27f',roughness:.8}));head.position.y=1.78;person.add(head);person.position.set(1.8,0,-.5);hazard.add(person);
      root.add(hazard);
      this.lookoutVisuals.intrusionActors=hazard;
      this.lookoutVisuals.intrusionVehicle=vehicle;
      this.intrusionVehicleMotionStart=null;
    }
  }

  buildTunnel(config, sceneData) {
    // 复用原 NEIYI 隧道洞壁与洞门，但轨道仍使用全区间同一条连续主线，
    // 避免隧道内再次叠加一套轨道而出现阶梯和接缝。
    const root = new THREE.Group();root.name='LOOKOUT_TUNNEL';this.lookoutRoot.add(root);
    for (let distance = config.tunnelStartDistance; distance < config.tunnelEndDistance - 1; distance += 100) {
      const segment = this.createSourceShapeObject(
        sceneData,
        'A1t100mStrtTun.s',
        `LOOKOUT_SOURCE_TUNNEL_SEGMENT_${distance}`,
        { groupFilter: (_group, _index, material) => material?.name === 'a_tunwall' },
      );
      if (!segment) break;
      this.placeLookoutObject3D(segment, distance);
      root.add(segment);
    }
    const entrance = this.createSourceShapeObject(sceneData, 'Cn_tunnel2.s', 'LOOKOUT_SOURCE_TUNNEL_ENTRANCE');
    if (entrance) { this.placeLookoutObject3D(entrance, config.tunnelStartDistance); root.add(entrance); }
    const exit = this.createSourceShapeObject(sceneData, 'Cn_tunnel2.s', 'LOOKOUT_SOURCE_TUNNEL_EXIT');
    if (exit) { this.placeLookoutObject3D(exit, config.tunnelEndDistance); exit.rotateY(Math.PI); root.add(exit); }

    // 洞外晴天先以一块高亮面形成过曝出口，洞门实体自然把它裁成洞口轮廓。
    // 靠近并出洞后再逐渐透明，不会成为始终挡在线路前方的白墙。
    const backlightMaterial=new THREE.MeshBasicMaterial({
      color:'#fff7dd',transparent:true,opacity:.98,side:THREE.DoubleSide,depthWrite:false,toneMapped:false,
    });
    const backlight=new THREE.Mesh(new THREE.PlaneGeometry(15,11.5),backlightMaterial);
    backlight.name='LOOKOUT_TUNNEL_EXIT_BACKLIGHT';
    this.placeLookoutObject3D(backlight,config.tunnelEndDistance+34,0,5.25);
    backlight.renderOrder=2;root.add(backlight);
    const halo=new THREE.Sprite(new THREE.SpriteMaterial({
      map:this.createSignalGlowTexture(),color:'#fff1c4',transparent:true,opacity:.72,
      depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,
    }));
    halo.name='LOOKOUT_TUNNEL_EXIT_GLARE';
    this.placeLookoutObject3D(halo,config.tunnelEndDistance+32,0,5.1);
    halo.scale.set(15.5,11.8,1);halo.renderOrder=3;root.add(halo);

    // 塌方实体放在洞口外，位于高亮天光之前。暗色岩体遮挡下部和右侧
    // 亮光，学生看到的是洞外剪影造成的不规则轮廓，而不是洞内彩色提示。
    const collapse=new THREE.Group();collapse.name='LOOKOUT_TUNNEL_EXIT_COLLAPSE';
    const rockMaterial=new THREE.MeshBasicMaterial({color:'#17140f',toneMapped:false});
    const rockLayout=[
      [3.25,2.55,.15,2.15,3.05,1.55,-.16],
      [1.65,1.45,-.1,2.05,1.8,1.55,.14],
      [.15,.75,.12,1.7,.92,1.35,-.08],
      [-1.75,.42,-.18,1.28,.62,1.08,.2],
      [-3.15,.3,.18,.8,.48,.86,-.12],
    ];
    rockLayout.forEach(([x,y,z,sx,sy,sz,rz],index)=>{
      const rock=new THREE.Mesh(new THREE.DodecahedronGeometry(1,1),rockMaterial);
      rock.name=`LOOKOUT_TUNNEL_EXIT_ROCK_${index+1}`;
      rock.position.set(x,y,z);rock.scale.set(sx,sy,sz);rock.rotation.set(.08,index*.17,rz);collapse.add(rock);
    });
    this.placeLookoutObject3D(collapse,config.hazardDistance);
    root.add(collapse);
    this.lookoutVisuals.tunnelAnomaly=collapse;
    this.lookoutVisuals.tunnelExitBacklight=backlight;
    this.lookoutVisuals.tunnelExitGlare=halo;
  }

  buildLookoutContinuationTrack(startDistance, endDistance) {
    const root=new THREE.Group();root.name='LOOKOUT_CONTINUATION_TRACK';
    const ribbon=(halfWidth,lateral,y,material,name)=>{
      const positions=[];const indices=[];let row=0;
      for(let distance=startDistance;distance<=endDistance+.01;distance+=6){
        const {point,right}=this.getLookoutPathFrame(Math.min(distance,endDistance));
        const center=point.clone().addScaledVector(right,lateral);center.y+=y;
        const a=center.clone().addScaledVector(right,-halfWidth);const b=center.clone().addScaledVector(right,halfWidth);
        positions.push(a.x,a.y,a.z,b.x,b.y,b.z);
        if(row>0){const base=(row-1)*2;indices.push(base,base+2,base+1,base+1,base+2,base+3);}row+=1;
      }
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere();
      const mesh=new THREE.Mesh(geometry,material);mesh.name=name;mesh.frustumCulled=false;root.add(mesh);
    };
    const ballastMaterial=new THREE.MeshStandardMaterial({color:'#686864',roughness:1,side:THREE.DoubleSide});
    const railMaterial=new THREE.MeshPhysicalMaterial({color:'#596269',metalness:.78,roughness:.24,clearcoat:.35,side:THREE.DoubleSide});
    ribbon(2.35,0,-.045,ballastMaterial,'LOOKOUT_BALLAST');
    ribbon(.055,-.7175,.035,railMaterial,'LOOKOUT_RAIL_LEFT');
    ribbon(.055,.7175,.035,railMaterial,'LOOKOUT_RAIL_RIGHT');
    const sleeperGeometry=new THREE.BoxGeometry(3.15,.12,.24);
    const sleeperMaterial=new THREE.MeshStandardMaterial({color:'#514d47',roughness:.96});
    const count=Math.floor((endDistance-startDistance)/12)+1;
    const sleepers=new THREE.InstancedMesh(sleeperGeometry,sleeperMaterial,count);sleepers.name='LOOKOUT_SLEEPERS';sleepers.frustumCulled=false;
    const object=new THREE.Object3D();
    for(let index=0;index<count;index+=1){const distance=startDistance+index*12;const {point,tangent}=this.getLookoutPathFrame(distance);object.position.copy(point);object.position.y-=.015;object.rotation.set(0,Math.atan2(tangent.x,tangent.z),0);object.updateMatrix();sleepers.setMatrixAt(index,object.matrix);}
    sleepers.instanceMatrix.needsUpdate=true;root.add(sleepers);this.lookoutRoot.add(root);
  }

  buildRailGlint(config) {
    const root = new THREE.Group();root.name='LOOKOUT_RAIL_GLINT';
    const material=new THREE.MeshBasicMaterial({color:'#f5fbff',transparent:true,opacity:.88,depthWrite:false,toneMapped:false});
    const buildSection=(start,end,name)=>{
      const positions=[];const indices=[];const step=6;let pair=0;
      for(const railOffset of [-.69,.69]){
        const sectionStart=pair;let localIndex=0;
        for(let distance=start;distance<=end+.01;distance+=step){
          const {point,right}=this.getLookoutPathFrame(Math.min(distance,end));
          const center=point.clone().addScaledVector(right,railOffset);center.y+=.055;
          const a=center.clone().addScaledVector(right,-.018);const b=center.clone().addScaledVector(right,.018);
          positions.push(a.x,a.y,a.z,b.x,b.y,b.z);
          if(localIndex>0){const base=sectionStart+(localIndex-1)*2;indices.push(base,base+2,base+1,base+1,base+2,base+3);}
          localIndex+=1;
        }
        pair+=localIndex*2;
      }
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeBoundingSphere();
      const mesh=new THREE.Mesh(geometry,material);mesh.name=name;mesh.renderOrder=4;mesh.frustumCulled=false;root.add(mesh);
    };
    // 反光边界与危险边界重合；异常点后持续暗哑，不再在危险点前预先断开。
    buildSection(config.glintStartDistance,config.hazardDistance,'LOOKOUT_GLINT_BEFORE_BREAK');
    buildSection(config.glintBreakEndDistance,config.glintEndDistance,'LOOKOUT_GLINT_AFTER_BREAK');
    this.lookoutRoot.add(root);this.lookoutVisuals.railGlint=root;
  }

  buildLookoutTrainingScenery(sceneData, prefabData, repairAssetData) {
    this.lookoutRoot=new THREE.Group();this.lookoutRoot.name='LOOKOUT_TRAINING_SCENERY';this.routeRoot.add(this.lookoutRoot);
    const [normal,tunnel,_rail,intrusion]=LOOKOUT_TRAINING_CONFIG.events;
    this.buildLookoutCatenaryRepairs(sceneData);
    this.buildTeachingThroughSignals(repairAssetData);
    this.buildCrossing(normal,prefabData,repairAssetData,false);
    this.buildTunnel(tunnel,sceneData);
    this.buildCrossing(intrusion,prefabData,repairAssetData,true);
  }

  updateLookoutTraining(attempt, distance) {
    if(!this.lookoutRoot)return;
    const tunnel=LOOKOUT_TRAINING_CONFIG.events.find((item)=>item.visualKind==='tunnel');
    const insideTunnel=distance>=tunnel.tunnelStartDistance&&distance<=tunnel.tunnelEndDistance;
    this.renderer.toneMappingExposure=insideTunnel ? .46 : 1.05;
    // 洞内依靠实体洞壁和较低曝光形成黑暗；高亮面不参与色调映射，
    // 因而保持近乎白色的出口光斑，形成洞内外高反差。
    if(insideTunnel){this.scene.background.set('#a7bdca');this.scene.fog.color.set('#a7b9c2');this.scene.fog.near=500;this.scene.fog.far=2200;}
    else {this.scene.background.set(this.scenarioId==='weather'?'#83929a':'#a7bdca');this.scene.fog.color.set(this.scenarioId==='weather'?'#83929a':'#a7b9c2');this.scene.fog.near=500;this.scene.fog.far=2200;}
    const tunnelEvent=attempt?.events?.['tunnel-hazard'];
    if(this.lookoutVisuals.tunnelAnomaly)this.lookoutVisuals.tunnelAnomaly.visible=!tunnelEvent?.cleared;
    const backlight=this.lookoutVisuals.tunnelExitBacklight;
    const glare=this.lookoutVisuals.tunnelExitGlare;
    if(backlight&&glare){
      const exitFade=1-THREE.MathUtils.smoothstep(distance,tunnel.tunnelEndDistance-2,tunnel.tunnelEndDistance+22);
      backlight.material.opacity=.98*exitFade;
      glare.material.opacity=.72*exitFade;
      backlight.visible=exitFade>.015;
      glare.visible=exitFade>.015;
    }
    const actors=this.lookoutVisuals.intrusionActors;
    if(actors){
      const config=LOOKOUT_TRAINING_CONFIG.events.find((item)=>item.id==='intrusion-crossing');
      const vehicle=this.lookoutVisuals.intrusionVehicle;
      const active=distance>=config.revealDistance-120&&distance<=config.passDistance+110;
      actors.visible=active;
      if(active&&vehicle){
        const now=performance.now()/1000;
        const cycleSeconds=8.5;
        // 首次进入观察区时车辆已接近道口，之后按真实时间循环横穿。
        // 动画不使用列车里程，因此学生停车后轿车仍会继续从左向右运动。
        if(this.intrusionVehicleMotionStart==null)this.intrusionVehicleMotionStart=now-cycleSeconds*.42;
        const phase=((now-this.intrusionVehicleMotionStart)%cycleSeconds)/cycleSeconds;
        vehicle.position.x=THREE.MathUtils.lerp(-24,24,phase);
      }else if(distance<config.revealDistance-120){
        this.intrusionVehicleMotionStart=null;
        if(vehicle)vehicle.position.x=-24;
      }
    }
  }

  setTrainingScenario(scenarioId) {
    this.scenarioId = scenarioId || 'normal';
    this.updateAtmosphere();
  }

  updateAtmosphere() {
    const weather = this.scenarioId === 'weather';
    const remaining = Math.max(0, ROUTE_CONTEXT.departureSignalDistance - this.distance);
    let near = 500;
    let far = 2200;
    let lampVisibility = 1;
    if (weather) {
      if (remaining > ROUTE_CONTEXT.weatherSignalApproachDistance) {
        near = 18; far = 110; lampVisibility = 0.08;
      } else if (remaining > ROUTE_CONTEXT.weatherSignalClearDistance) {
        near = 24; far = 185; lampVisibility = 0.34;
      } else {
        near = 85; far = 620; lampVisibility = 1;
      }
    }
    this.scene.background.set(weather ? '#83929a' : '#a7bdca');
    this.scene.fog.color.set(weather ? '#83929a' : '#a7b9c2');
    this.scene.fog.near = near;
    this.scene.fog.far = far;
    if (Math.abs(this.signalLampVisibility - lampVisibility) > 0.01) {
      this.signalLampVisibility = lampVisibility;
      this.setDepartureSignalAspect(this.signalAspect);
    }
  }

  hitTestDepartureSignal(clientX, clientY) {
    if (!this.departureSignal || !this.ready) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    this.camera.updateMatrixWorld(true);
    const head = this.departureSignal.root.localToWorld(new THREE.Vector3(0, 0.70, 0));
    head.project(this.camera);
    if (head.z < -1 || head.z > 1) return false;
    const screenX = rect.left + (head.x * 0.5 + 0.5) * rect.width;
    const screenY = rect.top + (-head.y * 0.5 + 0.5) * rect.height;
    // 真实信号机保持其路线尺度；课堂触控将命中范围扩展到 70 CSS 像素。
    return Math.hypot(clientX - screenX, clientY - screenY) <= 70;
  }

  getDepartureSignalScreenPosition() {
    if (!this.departureSignal || !this.ready) return null;
    this.camera.updateMatrixWorld(true);
    const head = this.departureSignal.root.localToWorld(new THREE.Vector3(0, 0.70, 0));
    head.project(this.camera);
    const visible = head.z >= -1 && head.z <= 1 && Math.abs(head.x) <= 1.08 && Math.abs(head.y) <= 1.08;
    return {
      visible,
      x: (head.x * 0.5 + 0.5) * 100,
      y: (-head.y * 0.5 + 0.5) * 100,
      remaining: ROUTE_CONTEXT.departureSignalDistance - this.distance,
    };
  }

  getPathPosition(distance, target = new THREE.Vector3()) {
    if (this.routePoints.length < 2 || this.pathLength <= 0) {
      return target.copy(this.forward).multiplyScalar(distance);
    }
    const clamped = THREE.MathUtils.clamp(distance, 0, this.pathLength);
    let low = 0;
    let high = this.routeDistances.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (this.routeDistances[middle] <= clamped) low = middle;
      else high = middle;
    }
    const startDistance = this.routeDistances[low];
    const segmentLength = this.routeDistances[high] - startDistance;
    const ratio = segmentLength > 0 ? (clamped - startDistance) / segmentLength : 0;
    return target.lerpVectors(this.routePoints[low], this.routePoints[high], ratio);
  }

  setView(view) {
    this.view = view;
    this.applyCamera();
  }

  update(distance, speed, view = this.view, signalVisible = false, wholeTrainStartFraction = 1) {
    this.distance = Math.max(0, Number(distance) || 0);
    this.speed = Math.max(0, Number(speed) || 0);
    this.wholeTrainStartFraction = THREE.MathUtils.clamp(Number(wholeTrainStartFraction) || 0, 0, 1);
    if (this.wholeTrainStartFraction > 0.018 && this.lastStartFraction <= 0.018) this.startMotionAt = performance.now() / 1000;
    if (this.wholeTrainStartFraction <= 0.001 && this.lastStartFraction > 0.001) this.startMotionAt = null;
    this.lastStartFraction = this.wholeTrainStartFraction;
    this.view = view;
    this.canvas.classList.toggle('live', this.ready && (this.distance > 0.2 || view !== 'front' || signalVisible));
    this.updateAtmosphere();
    this.updatePassengerConsist(this.wholeTrainStartFraction);
    this.applyCamera();
    this.updateSignalTeachingVisibility();
  }

  applyCamera() {
    const routeDistance = this.startOffset + this.distance;
    const position = this.getPathPosition(routeDistance);
    const tangentStart = this.getPathPosition(Math.max(0, routeDistance - 3));
    const tangentEnd = this.getPathPosition(Math.min(this.pathLength || routeDistance + 6, routeDistance + 6));
    const tangent = tangentEnd.sub(tangentStart);
    tangent.y = 0;
    if (tangent.lengthSq() > 0.000001) this.forward.copy(tangent.normalize());
    const baseYaw = Math.atan2(-this.forward.x, -this.forward.z);
    const yawOffsets = {
      front: 0,
      left: THREE.MathUtils.degToRad(65),
      right: THREE.MathUtils.degToRad(-65),
      rearLeft: THREE.MathUtils.degToRad(165),
      rearRight: THREE.MathUtils.degToRad(-165),
    };
    const pitchOffsets = { front: -0.22, left: -0.035, right: -0.035, rearLeft: -0.04, rearRight: -0.04 };
    const lateralOffsets = { front: 0, left: -0.7, right: 0.7, rearLeft: -3.2, rearRight: 3.2 };
    const longitudinalOffsets = { front: 0, left: 0, right: 0, rearLeft: -1.8, rearRight: -1.8 };
    const right = new THREE.Vector3(this.forward.z, 0, -this.forward.x);
    this.camera.position.copy(position);
    this.camera.position.addScaledVector(right, lateralOffsets[this.view] || 0);
    this.camera.position.addScaledVector(this.forward, longitudinalOffsets[this.view] || 0);
    this.camera.position.y += this.eyeHeight;
    const pulseAge = this.startMotionAt == null ? 99 : Math.max(0, performance.now() / 1000 - this.startMotionAt);
    const lowSpeedFactor = 1 - THREE.MathUtils.clamp(this.speed / 15, 0, 1);
    const cabPulse = Math.exp(-2.15 * pulseAge) * lowSpeedFactor;
    this.camera.position.addScaledVector(this.forward, Math.sin(pulseAge * 9.2) * 0.024 * cabPulse);
    this.camera.position.y += Math.sin(pulseAge * 7.1 + 0.4) * 0.012 * cabPulse;
    if (this.ground) this.ground.position.set(position.x, position.y - 0.18, position.z);
    this.camera.rotation.order = 'YXZ';
    const pitchSway = Math.sin(pulseAge * 7.1) * 0.0028 * cabPulse;
    const rollSway = Math.sin(pulseAge * 5.8 + 0.7) * 0.0022 * cabPulse;
    this.camera.rotation.set((pitchOffsets[this.view] ?? pitchOffsets.front) + pitchSway, baseYaw + (yawOffsets[this.view] || 0), rollSway);
  }

  resize() {
    const parent = this.canvas.parentElement || this.canvas;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.resizeObserver?.disconnect();
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    this.scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      objectMaterials.forEach((material) => {
        materials.add(material);
        Object.values(material).forEach((value) => {
          if (value?.isTexture) textures.add(value);
        });
      });
    });
    this.materialCache.forEach((material) => materials.add(material));
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    this.renderer.renderLists?.dispose();
    this.renderer.dispose();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
