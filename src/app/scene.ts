import * as THREE from "three";
import { ArchiveVisibility } from "./archive-visibility";
import { InstanceUpdates } from "./instance-updates";
import { disposeThreeTree } from "./three-resources";
import { ThemeWave } from "./theme-motion";
import { themeMaterial, themeEnvironment, arrayFade } from "./theme-material";
import { RhythmMotion, rhythmDisplacement, quietBands, type MusicBands, type RhythmStyle } from "./archive-play-motion";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createArchiveLighting, type LightingLook } from "./archive-lighting";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { normalizeQuality, type RenderQuality } from "./render-quality";
import { applyTextureQuality, resizeQuality } from "./quality-renderer";
import { CardAppearance } from "./appearance";
import { configureInternalOptics } from "./internal-optics";
import { DecryptionController } from "./decryption";
import { fileAtSlot, fileLocation, records } from "./data";
import {
  cellKey,
  sameCell,
  selectionCell,
  fileAtCell,
  poolCell,
  duplicateRank,
  inkForRank,
  LOOP_COLUMNS,
  LOOP_ROWS,
  COLUMN_SPACING,
  ROW_SPACING,
  type ArchiveCell,
  type ArchiveNavigation,
} from "./archive-loop";
import { labelMarkSvg, galleryName } from "./brand";
import { archiveFraming, CARD_GROWTH } from "./viewport-layout";
import { ArchiveDrag, ArchivePlaneMomentum, type DragAxis, type DragProjection, type DragPosition } from "./archive-drag";
import { assetUrl as publicAsset } from "./asset-url";
import {
  archiveWave,
  extraction,
  baselineSelectionWave,
  rippleEnvelope,
  settlingWave,
  damp,
  dampSpring,
  BODY_ZETA,
  columnStrength,
  idleWave,
  cinematicField,
  INSPECTION_LIFT,
  returnStep,
} from "./motion";

const ease = (t: number) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** 卡片变薄（参数量，非换模型）：原版档案盒总厚 0.376，压到 0.14（与音乐
 *  项目 V0.4.0 薄卡盒同厚度）。只在 Z 轴压缩几何——X/Y 构图、材质观感、
 *  实例化管线与描边动画全不变，因此不吃"换模型"的性能亏；侧视厚度变为
 *  原来的 37%，排布密度与观感转薄卡片样式。 */
const CARD_THICKNESS_SCALE = 0.14 / 0.376;
/** 压缩后卡片正面的 Z 位置（原正面 0.246 × scale），贴花与内容面据此对位。 */
const CARD_FACE_Z = 0.246 * CARD_THICKNESS_SCALE;
/** 卡片正面尺寸（世界单位）。竖版资产 4.0×5.0（2026-10-16 由
 *  art/build_archive_portrait.py 从原横版 5.01×3.70 纯等比映射产出）。
 *  厚度 0.376 两版完全一致，所以 CARD_THICKNESS_SCALE / CARD_FACE_Z 都不用动。 */
const CARD_W = 4.0;
const CARD_H = 5.0;
/** 卡片可动范围（世界单位）：正面 x∈[−CARD_W/2, CARD_W/2]，y∈[0, CARD_H]。 */
const CARD_HALF_W = CARD_W / 2;
/** B 路线补偿系数：墙阵列实例把竖版资产反向映射回已认可的横版观感（5.010×3.700）。
 *  抽出/详情卡在 detail=1 时恢复 (1,1,1) 原生竖版，随 detail 连续插值防跳变。 */
const WALL_SX = 5.010 / 4.000;
const WALL_SY = 3.700 / 5.000;
/** 卡片里不再显示的内部构建物（同心光学环 / 光学腔 / 内部基板等）。
 *  这些部件本来就不进墙阵列（见 load() 里的阵列白名单），只挂在被抽出的那一张
 *  卡上，透过磨砂盖面显出一圈圈同心环。用户裁定：卡片里不要这套内构，只保留
 *  外壳、边框、螺丝与左上角的贴花标签。 */
const CARD_INTERNAL_PARTS = [
  "Internal_Ceramic",
  "Optical_Edges",
  "Subsurface_Optics",
  "Optical_Film_Edge",
  "Amber_Optical_Inlay",
  "Optical_Film",
];

/** 卡片内容面（P4 定案后 v2 版式）：阵列里每张卡只有左缘约 0.9 单位的一条竖带
 *  对长焦相机可见（其余被视线方向的相邻卡遮挡——原片标签画左上角的同一原因），
 *  所以墙面内容改成「书脊式」窄条：编号/标题/分类/日期竖排旋转 90°。
 *  完整四行内容放在抽出/详情卡正面（detailFace，见 load()）。
 *  图集机制不变：逐实例 aPrintOffset + 网格 uniform，8 列动态行数。 */
const PRINT_ATLAS_COLS = 8;
/** 单格设计尺寸（像素）：书脊竖条 128×448（≈0.9:3.2 世界比例）。 */
const PRINT_CELL_W = 128;
const PRINT_CELL_H = 448;
/** 可见带宽度与位置：横版盖面 x∈[−2.5,2.5]（世界），相机在 −x 侧 → 贴左缘。
 *  书脊条实例与卡片实例共用同一补偿矩阵（WALL_SX/WALL_SY），所以几何按竖版
 *  局部坐标反除补偿系数（世界 0.9×3.2 @ (−2.05,1.72) ⇔ 局部 ≈0.719×4.324）；
 *  图集仍按世界比例绘制（128×448），补偿后文字在世界空间不变形。 */
const PRINT_STRIP_W = 0.9 / WALL_SX;
const PRINT_STRIP_X = -CARD_HALF_W + PRINT_STRIP_W / 2;
const PRINT_STRIP_H = 3.2 / WALL_SY;
const PRINT_STRIP_Y = 1.72 / WALL_SY;
function drawPrintAtlas(canvas: HTMLCanvasElement, items: { id: string; title: string; category: string; date: string; en: string; imageUrl?: string }[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const CW = PRINT_CELL_W;
  const CH = PRINT_CELL_H;
  const truncate = (text: string, limit: number) =>
    text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  // 书脊文字：旋转 -90° 从下往上读；锚点在右缘，字形向左展开。
  const spine = (text: string, cx: number, cy: number, font: string, fill: string) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 2);
    ctx.font = font;
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  items.forEach((rec, i) => {
    if (i >= PRINT_ATLAS_COLS * Math.ceil(items.length / PRINT_ATLAS_COLS)) return;
    const x0 = (i % PRINT_ATLAS_COLS) * CW;
    const y0 = Math.floor(i / PRINT_ATLAS_COLS) * CH;
    ctx.fillStyle = "#e6e2d9";
    ctx.fillRect(x0, y0, CW, CH);
    ctx.fillStyle = "#171713";
    ctx.fillRect(x0 + 8, y0 + 12, CW - 16, 3);
    ctx.fillRect(x0 + 8, y0 + CH - 14, CW - 16, 2);
    if (rec.imageUrl) {
      // 图片卡书脊（2026-10-16 用户「阵列时还是不太明显能看到图」＋「不要『本层档案』
      // 这些」）：图占 y16..276（格高 448 的 58%），标题留 y286..430 专用带——竖排文字
      // 从锚点向上展开，7 字 ×20px = 140 恰好装满该带，不与图重叠；分类/日期/编号不画。
      spine(truncate(rec.title, 7), x0 + 104, y0 + 430, "700 20px MiSans, Noto Sans SC", "#171713");
      return;
    }
    spine(truncate(rec.id, 8), x0 + 104, y0 + 148, "500 26px MiSans, Noto Sans SC", "#8b8474");
    spine(truncate(rec.title, 9), x0 + 104, y0 + 258, "700 24px MiSans, Noto Sans SC", "#171713");
    spine(truncate(rec.category, 10), x0 + 104, y0 + 348, "500 15px MiSans, Noto Sans SC", "#878476");
    ctx.globalAlpha = 0.62;
    spine(truncate(rec.date, 12), x0 + 104, y0 + 424, "500 13px MiSans, Noto Sans SC", "#171713");
    ctx.globalAlpha = 1;
  });
}
export class ArchiveScene {
  private inputEvents = new AbortController();
  private presence = 1;
  private presenceTarget = 1;
  setPresentationVisible(visible: boolean, immediate = false) {
    this.presenceTarget = Number(visible);
    if (immediate) this.presence = this.presenceTarget;
    if (!visible) this.cancelPointer();
  }
  get presentationHidden() { return this.presenceTarget === 0 && this.presence === 0; }
  private presentationDrop(cell: ArchiveCell) {
    const delay = .15 * (1 + Math.tanh((cell.row - this.selectedCell.row) * .1 + (cell.lane - this.selectedCell.lane) * .25));
    return 35 * Math.pow(THREE.MathUtils.clamp((1 - this.presence - delay) / .7, 0, 1), 2);
  }
  revealImmediately() { this.reveal = this.targetReveal; }
  dispose() {
    this.inputEvents.abort();
    this.cancelPointer();
    disposeThreeTree(this.scene);
    this.appearance.disposeSources();
    this.model.clear();
    this.outgoing = [];
    this.instances = [];
    this.assemblyTemplate?.then(disposeThreeTree).catch(() => {});
    this.assemblyTemplate = undefined;
    this.light.shadow.map?.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.loaded = false;
  }
  uiOnlyParallax = false;
  private theme = new ThemeWave();
  private subduedIndex = { value: 0 };
  private selectedIndexOnly = false;
  private superPerformance = false;
  setSuperPerformance(enabled: boolean) {
    if (this.superPerformance === enabled) return;
    this.superPerformance = enabled;
    // ⑦c：CSS 暗角只挂 data 标志，由 style.css 合成层实现（不走 composer，零 GL 成本）。
    this.container.dataset.superPerformance = String(enabled);
    for (const inst of this.instances) {
      const original = (inst.userData.fullMaterial ??= inst.material) as THREE.MeshPhysicalMaterial;
      if (enabled && !inst.userData.fastMaterial) {
        const fast = original.clone();
        fast.onBeforeCompile = original.onBeforeCompile;
        fast.customProgramCacheKey = original.customProgramCacheKey.bind(original);
        // ⑦c 性能档质感（2026-10-15）：只加便宜项——薄清漆高光、略提环境反射、
        // 粗糙度下限 0.45→0.38；均不新增绘制通道或缓冲。最贵的折射仍为 0。
        // 注意：内容面印刷批次是 MeshLambertMaterial，不支持 clearcoat/roughness
        // （给它定义 USE_CLEARCOAT 会直接编译失败），必须按材质类型门控。
        fast.transmission = 0;
        const isStandard = (original as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
        const isPhysical = (original as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial === true;
        // clearcoat 仅 Physical 材质（WebGLPrograms 无条件读 material.clearcoat>0，
        // 给 Standard/Lambert 定义 USE_CLEARCOAT 会导致着色器编译失败）。
        fast.clearcoat = isPhysical ? 0.25 : 0;
        if (isPhysical) fast.clearcoatRoughness = 0.25;
        if (isStandard) {
          fast.roughness = Math.max(.38, original.roughness);
          fast.envMapIntensity = Math.min(1, original.envMapIntensity * 1.25);
        }
        inst.userData.fastMaterial = fast;
      }
      inst.material = enabled ? inst.userData.fastMaterial : original;
      // 螺丝批次不再随性能档隐藏（一次实例化绘制，开销可忽略；用户要求显示）。
    }
    this.resize();
  }
  setSelectedIndexAccent(onlySelected: boolean) { this.selectedIndexOnly = onlySelected; }
  /** 图形上下文丢失后的恢复尝试（宿主/内部在 webglcontextlost 时调用）。 */
  restoreGraphics() {
    try {
      const renderer = this.renderer as unknown as { forceContextRestore?: () => void };
      renderer.forceContextRestore?.();
      this.resize();
      return true;
    } catch {
      return false;
    }
  }

  /** 当前 WebGL 上下文是否已丢失。 */
  get graphicsLost() {
    try {
      return this.renderer.getContext().isContextLost();
    } catch {
      return true;
    }
  }

  private themeAttribute?: THREE.InstancedBufferAttribute;
  get themeAmount() { return this.theme.background(performance.now() / 1000); }
  setTheme(dark: boolean, immediate = false) { this.theme.set(dark, performance.now() / 1000, this.selectedCell, immediate); }
  private playfield = { enabled: false, bands: quietBands(), strength: 1, flatten: 0, target: null as string | null, breathing: true };
  private flatMix = 0;
  private rhythm = new RhythmMotion();
  private rhythmStyle: RhythmStyle = "legacy";
  setRhythmStyle(style: RhythmStyle) { this.rhythmStyle = style; }
  private relayLifts = new Map<string, number>();
  private relayPoints = new Map<string, { cell: ArchiveCell; point: THREE.Vector3 }>();
  private relayActive = false;
  onRelayPick?: (key: string | null) => void;
  setPlayfield(enabled: boolean, bands: MusicBands, strength: number, flatten: number, target: string | null, breathing = true) {
    this.playfield = { enabled, bands, strength, flatten, target, breathing };
  }
  setRelayActive(active: boolean) {
    if (active === this.relayActive) return;
    this.cancelPointer(); this.setHover(null); this.relayActive = active;
    this.pointer.set(0, 0);
  }
  relayPulse(key: string) {
    const cell = this.relayPoints.get(key)?.cell;
    if (cell && !this.reduced) this.emitPulse(cell);
  }
  projectRelay(key: string) {
    const item = this.relayPoints.get(key);
    if (!item) return null;
    const point = item.point.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }
  relayCandidates() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.scene.updateMatrixWorld(true);
    return [...this.relayPoints.keys()].filter(key => {
      const p = this.projectRelay(key)!;
      const x = (p.x - rect.left) / rect.width, y = (p.y - rect.top) / rect.height;
      if (x < .18 || x > .82 || y < .32 || y > .76) return false;
      const hit = this.pickCell(p.x, p.y);
      return hit && cellKey(hit) === key;
    });
  }
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  // The reference uses a long lens 72–140 units from the cassette. A 0.1 near
  // plane quantizes adjacent optical layers to the same depth (visible shimmer).
  // All visible foreground geometry is beyond 5; retain the framing and lens.
  readonly camera = new THREE.PerspectiveCamera(34, 16 / 9, 5, 300);
  private composer: EffectComposer;
  private ao: SSAOPass;
  private bokeh: BokehPass;
  private instances: THREE.InstancedMesh[] = [];
  /** 阵列实例数据的上传器：只传变化区间（原做法每帧整块重传）。
   *  前提：5 个部件永远共用同一批实例变换（见下方 setMatrixAt 的唯一调用点）。 */
  private matrixUpdates?: InstanceUpdates;
  private themeUpdates?: InstanceUpdates;
  private visibility = new ArchiveVisibility();
  private instanceCapacity = LOOP_COLUMNS * LOOP_ROWS;
  private drawnCells: ArchiveCell[] = [];
  /**
   * 近→远绘制该不该开。
   *
   * 卡片是实心不透明体，谁先画都不改final像素；但若先从远处画，近处卡片最后覆盖时，
   * 那些被盖住的像素已经白算了一遍着色。改成按相机深度由近及远提交，
   * 被遮住的像素在 early-Z 阶段就被剔除，不进入片元着色。
   *
   * 为什么值得做：配对测量（probe-array-paired.mjs，已抵消核显热降频漂移）显示
   * 阵列 7 次 draw 占 75% 帧时间，而实例数从 300 砍到 60、三角形从 133 万到零头
   * 都不省钱 → 成本在「逐像素着色」，不在几何提交。合批因此无意义（本来只有 7 次 draw）。
   * 保留为可切换字段，便于用配对探针 A/B 复核，也便于出问题时一键退回。
   */
  nearToFarDraw = true;
  private extraCoverage = false;
  setArchiveCoverage(extra: boolean) { this.extraCoverage = extra; }
  private model = new THREE.Group();
  private appearance = new CardAppearance();
  private decryption = new DecryptionController();
  private cursor = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private cells: ArchiveCell[] = [];
  private selectedCell: ArchiveCell = { lane: 2, row: 12 };
  private looping = false;
  /** 当前场景模式（hidden/archive/detail）。详情态提清逻辑用：进出 detail 时重算渲染缓冲。 */
  private mode: "hidden" | "archive" | "detail" = "hidden";
  /** 详情态提清开关（entry 按帧率阶梯控制）。>0 时 resize 用大像素预算买分辨率。
   *  2=全清 1080p / 1=半清 1.33MP（约 1536×864）/ 0=常规。阶梯由 entry 驱动。 */
  private detailBoostLevel = 0;
  /** 淡出到位后阵列批次是否已停画（双阈值迟滞，见 update）。诊断可读。 */
  arrayCulled = false;
  /** 兼容探针/旧调用：布尔视角的提清开关。 */
  get detailBoost() { return this.detailBoostLevel > 0; }
  /** 详情态提清使用的像素预算：约 2.07 MP（1080p 全尺寸）。回阵列恢复 921600/8.3MP 常规路径。 */
  static readonly DETAIL_BOOST_BUDGET = 2_073_600;
  /** 半清档：1.33 MP（1920×1080 下 ratio 0.8 → 1536×864），帧率约为全清档 1.5 倍。 */
  static readonly DETAIL_BOOST_MID_BUDGET = 1_327_104;
  /** 详情态提清时叠加在当前画质 scale 上的补偿：性能优先档 scale 60 → 100。 */
  static readonly DETAIL_BOOST_SCALE = 100;
  private coordinateOrigin: ArchiveCell = { lane: 0, row: 0 };
  private lift = { value: 0, velocity: 0 };
  private rail = { value: 0, velocity: 0 };
  private shoulder = { value: 12, velocity: 0 };
  private laneFocus = { value: 2, velocity: 0 };
  private columnCamera = { value: 0, velocity: 0 };
  private returnY: number | null = null;
  private canInspect = false;
  private clearance = 0;
  private pulseGain = 1;
  private idleGain = 0;
  private lastInteraction = 0;
  private scanTime = 29.1;
  private scanBlend = 0;
  private cameraAim = new THREE.Vector3();
  /** 最近一次"可信"的取景测量。容器被隐藏时尺寸为 0，算出的取景会把相机瞄准点污染成
   *  NaN/Infinity，而 NaN 会通过 lerp 永久传染（画面凭空消失、DOM 完好）。 */
  private framing: ReturnType<typeof archiveFraming> | null = null;
  private outgoing: {
    group: THREE.Group;
    slot: number;
    cell: ArchiveCell;
    lift: { value: number; velocity: number };
    returnY: number | null;
    clarity: number;
  }[] = [];
  private pulses: { row: number; lane: number; time: number }[] = [];
  private pendingPulse: ArchiveCell | null = null;
  private selectedSlot = 76;
  private detail = 0;
  private targetDetail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private last = 0;
  private pointer = new THREE.Vector2();
  private dragging = false;
  private hoverCell: ArchiveCell | null = null;
  private hoverLifts = new Map<string, number>();
  private archiveDrag = new ArchiveDrag();
  private dragTrack: DragPosition | null = null;
  private navigatingDrag = false;
  private archiveMomentum: { motion: ArchivePlaneMomentum; time: number } | null = null;
  private holdingArchive = false;
  private cancelPointer = () => {};
  private rotation = 0;
  private targetRotation = 0;
  private light: THREE.DirectionalLight;
  private clock = 0;
  private loaded = false;
  private labelCanvas = document.createElement("canvas");
  private labelTexture?: THREE.CanvasTexture;
  /** 卡片内容面：图集纹理 + 逐实例 UV 偏移（aPrintOffset），与墙批次共用实例矩阵。 */
  private printOffset?: THREE.InstancedBufferAttribute;
  /** 短列重复副本的逐实例墨色（aInk，1=全浓）；随 printOffset 同生命周期扩容。 */
  private printInk?: THREE.InstancedBufferAttribute;
  private inkUpdates?: InstanceUpdates;
  private printUpdates?: InstanceUpdates;
  /** 图集行数（按记录数动态决定），UV 归一化与贴图创建共用。 */
  private printAtlasRows = 1;
  /** 图集网格（列数, 行数）→ 着色器 uniform。用 uniform 而非编译期常量，
   *  目录切换导致行数变化时无需重编译着色器（避免程序缓存抖动）。 */
  private printGrid = { value: new THREE.Vector2(PRINT_ATLAS_COLS, 1) };
  /** 内容面资源句柄，供目录切换时重绘图集（records 是原地变更的）。 */
  private printCanvas?: HTMLCanvasElement;
  private printTexture?: THREE.CanvasTexture;
  private printMaterial?: THREE.MeshLambertMaterial;
  /** 详情/抽出卡正面完整内容面（P4 方案 C 的 B 半）。 */
  private detailFace?: THREE.Mesh;
  private detailFaceCanvas?: HTMLCanvasElement;
  private detailFaceTexture?: THREE.CanvasTexture;
  private labelMark = new Image();
  private reduced = false;
  private quality = normalizeQuality(undefined);
  private appliedQuality = "";
  private smaa = new SMAAPass();
  private aoKernelSize = 32;
  private displayHeight = 0;
  private layoutKind = "";
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onHover?: (index: number | null) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  constructor(
    private container: HTMLElement,
    private readonly selectionPulse = baselineSelectionWave,
    private readonly deferSelectionPulse = false,
    private readonly lightingLook: LightingLook = "baseline",
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5) *
        Math.min(innerWidth / 1920, innerHeight / 1080),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    // 同一帧内主画面 / 环境遮蔽 / 景深 / 折射四个通道看的是同一批几何：
    // 阴影只在真正绘制的那一帧生成一次，由 render 显式触发。
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "三维研究档案阵列，点击选择，左右拖动切列，上下拖动或滚轮切换列内档案",
    );
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color("#eae5e1");
    // 世界矩阵改为每帧在绘制前统一更新一次（见 render）。
    // 注意：任何在 render 之后改 transform 又要立刻读 matrixWorld 的代码，
    // 必须自己调 updateMatrixWorld（本文件的 projectCard / relayCandidates 已显式调用）。
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.fog = new THREE.Fog("#eae5e1", 22, 47);
    this.light = createArchiveLighting(this.renderer, this.scene, lightingLook);
    this.light.castShadow = true;
    Object.assign(this.light.shadow.camera, {
      left: -16,
      right: 16,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 45,
    });
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = lightingLook === "refined" ? 0.018 : 0.035;
    this.light.shadow.bias = lightingLook === "refined" ? -0.00012 : -0.0003;
    this.light.shadow.radius = 4;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: "#d8c9b9", roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.name = "archive-floor";
    floor.position.y = -4.63;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.fov = 6.15;
    this.camera.lookAt(this.cameraAim);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SSAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.ao.kernelRadius = lightingLook === "refined" ? 0.44 : 0.38;
    this.ao.minDistance = 0.001;
    this.ao.maxDistance = 0.09;
    this.composer.addPass(this.ao);
    this.bokeh = new BokehPass(this.scene, this.camera, {
      focus: 25,
      aperture: 0.0018,
      maxblur: 0.011,
    });
    this.composer.addPass(this.bokeh);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    this.bindPointer();
  }
  async load(assetUrl = publicAsset("assets/archive-cassette.glb")) {
    this.labelMark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
    await this.labelMark.decode();
    const gltf = await new GLTFLoader().loadAsync(
      assetUrl,
    );
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const count = LOOP_COLUMNS * LOOP_ROWS;
    for (let index = 0; index < count; index++) {
      const cell = poolCell(index);
      this.cells.push(cell);
    }
    for (const mesh of meshes) {
      const source = mesh.material as THREE.MeshStandardMaterial;
      const name = source.name.replace(/\.\d+$/, "");
      // 内部构建物直接跳过：不建网格、也不进 appearance 调色板。
      if (CARD_INTERNAL_PARTS.includes(name)) continue;
      const geom = mesh.geometry
        .clone()
        .applyMatrix4(mesh.matrixWorld)
        // 卡片变薄（参数量）：只在 Z（厚度）方向压缩，X/Y 构图与材质不变。
        .scale(1, 1, CARD_THICKNESS_SCALE);
      const mat = source.clone() as THREE.MeshPhysicalMaterial;
      mat.envMapIntensity = 0.6;
      if (name === "Frosted_Polymer") {
        mat.color.set("#fffdfa");
        mat.transmission = 0.9;
        mat.thickness = 0.12;
        mat.roughness = 0.21;
        mat.ior = 1.46;
        mat.attenuationColor = new THREE.Color("#eee6df");
        mat.attenuationDistance = 2;
      }
      if (name === "Internal_Ceramic") {
        mat.color.set(this.lightingLook === "refined" ? "#c4baae" : "#c7beb6");
        mat.roughness = 0.6;
      }
      if (name === "Printed_Label") mat.color.set("#eae5dc");
      if (name === "Ivory_Edges") {
        mat.color.set("#f0e7df");
        mat.roughness = 0.31;
        mat.transmission = 0.65;
        mat.thickness = 0.04;
      }
      if (name === "Optical_Diffuser") {
        mat.color.set("#e2dad4");
        mat.transmission = 0;
        mat.roughness = 0.7;
      }
      if (name === "Subsurface_Optics") {
        mat.color.set(this.lightingLook === "refined" ? "#b9a796" : "#b9aba1");
        mat.roughness = 0.48;
        mat.metalness = 0.05;
      }
      if (name === "Optical_Edges") {
        // Internal refractive shoulders must be in the opaque capture: WebGL's
        // screen-space transmission cannot recursively sample another glass mesh.
        mat.transmission = 0;
        mat.color.set(this.lightingLook === "refined" ? "#d8c7b5" : "#d4c7be");
        mat.roughness = 0.26;
        mat.metalness = 0.08;
      }
      configureInternalOptics(name, mat);
      if (name === "Carbon_Ink") continue;
      const selectedMesh = new THREE.Mesh(geom, mat);
      selectedMesh.userData.surface = name;
      selectedMesh.castShadow = name === "Optical_Diffuser";
      selectedMesh.receiveShadow = true;
      this.model.add(selectedMesh);
      // Only the shell, edge and fasteners remain visible within tightly packed rows.
      // Keep sub-millimetre optical/typographic geometry on the extracted cassette.
      if (
        ![
          "Frosted_Polymer",
          "Ivory_Edges",
          "Titanium_Fasteners",
          "Index_Inlay",
          "Optical_Diffuser",
        ].includes(name)
      ) {
        this.appearance.register(name, mat);
        continue;
      }
      const arrayMat = mat.clone();
      if (name === "Frosted_Polymer") {
        arrayMat.transmission = 0.78;
        if (this.lightingLook === "refined") {
          // Longer oblique paths pick up the warm body tint, while the thin
          // edges and the extracted clear cover retain a brighter response.
          arrayMat.thickness = 0.28;
          arrayMat.attenuationColor.set("#d4c7b4");
          arrayMat.attenuationDistance = 1.2;
        }
        arrayMat.transparent = false;
        arrayMat.color.set("#fff7ed");
        arrayMat.onBeforeCompile = (shader) => {
          shader.vertexShader =
            "varying float vPanelHeight;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 5.0;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\n" + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight));",
          );
        };
        arrayMat.roughness = 0.28;
        arrayMat.clearcoat = 0.3;
        arrayMat.clearcoatRoughness = 0.25;
      }
      if (name === "Optical_Diffuser") arrayMat.color.set("#806447");
      if (name === "Ivory_Edges") {
        arrayMat.transmission = 0;
        arrayMat.color.set(
          this.lightingLook === "refined" ? "#dcc9b0" : "#fff5e9",
        );
        arrayMat.roughness = 0.38;
      }
      if (name === "Index_Inlay") {
        arrayMat.color.set("#e4d6c5");
        arrayMat.metalness = 0.05;
      }
      this.appearance.register(name, mat, arrayMat);
      this.themeAttribute ??= new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("archiveTheme", this.themeAttribute);
      themeMaterial(arrayMat, name, true, this.subduedIndex);
      const inst = new THREE.InstancedMesh(geom, arrayMat, count);
      inst.userData.surface = name;
      // 所有表面都是刚性同步移动 → 共用第一份实例矩阵缓冲，显存里只留一张表。
      inst.instanceMatrix = this.instances[0]?.instanceMatrix ?? inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = name === "Optical_Diffuser";
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.instances.push(inst);
      this.scene.add(inst);
    }
    // —— 卡片内容面（墙面每张卡正面的档案信息）——
    // 图集按记录数动态排布；逐实例 UV 偏移让每张卡显示自己那一格。
    const printCanvas = document.createElement("canvas");
    const atlasRows = Math.max(1, Math.ceil(records.length / PRINT_ATLAS_COLS));
    this.printAtlasRows = atlasRows;
    this.printCanvas = printCanvas;
    this.printGrid.value.set(PRINT_ATLAS_COLS, atlasRows);
    printCanvas.width = PRINT_ATLAS_COLS * PRINT_CELL_W;
    printCanvas.height = atlasRows * PRINT_CELL_H;
    drawPrintAtlas(printCanvas, records);
    const printTexture = new THREE.CanvasTexture(printCanvas);
    printTexture.colorSpace = THREE.SRGBColorSpace;
    // 图集采样三件套（2026-10-17 实测定位「真机阵列只有抽起那张有图、背景卡全空白」）：
    // ① 关 mipmap：逐级 mip 会把相邻格（深蓝封面 vs 纸色空格）连同平均，图被洗回纸色；
    // ② LinearFilter：与 ① 配套；
    // ③ anisotropy = 1：各向异性采样沿主轴做额外平均，SwiftShader 上 getMaxAnisotropy()
    //    返回 2 也足以把 128px 窄格洗白（变量矩阵实测：mips 关 + aniso=2 仍无图，
    //    aniso=1 深蓝像素 1068 → 101515）。窄条书脊在世界空间只有 ~0.9 单位宽，
    //    各向异性带来的清晰度收益在此不可见，必须让位于颜色保真。
    // 125% 屏 + 性能档下绘图缓冲仅 1075×604（0.7×），缩小最狠，所以只有该环境全空。
    printTexture.generateMipmaps = false;
    printTexture.minFilter = THREE.LinearFilter;
    printTexture.anisotropy = 1;
    // applyTextureQuality 会把全部纹理的各向异性刷成画质档数值（性能档=2），
    // 必须给图集挂免死金牌，否则 load() 里的 anisotropy=1 会被覆盖回洗白状态。
    printTexture.userData.keepFiltering = true;
    this.printTexture = printTexture;
    const printMat = new THREE.MeshLambertMaterial({
      map: printTexture,
      toneMapped: false,
      transparent: false,
    });
    this.printMaterial = printMat;
    this.drawSpineThumbs();
    printMat.onBeforeCompile = (shader) => {
      shader.uniforms.rhinePrintGrid = this.printGrid;
      // 书脊条同样参与详情态墙面淡出（与 theme-material 的 arrayFade 共用同一 uniform 对象）。
      shader.uniforms.rhineArrayFade = arrayFade;
      // ⚠️ 顺序坑（2026-10-16 实测定位）：meshlambert 顶点模板里 <uv_vertex>（:22）
      // 在 <begin_vertex>（:35）之前。旧写法在 <begin_vertex> 处才
      // `vPrintOffset = aPrintOffset`，而 <uv_vertex> 处的
      // `vMapUv = vMapUv/grid + vPrintOffset` 先执行 → 读未初始化 varying，
      // ANGLE/D3D11 下恒为 0 → 所有实例都采样 UV 左下格（图集最后一行），
      // 整墙书脊全部显示同一份档案（用户实拍的 X-089）。
      // 修复：attribute 在顶点着色器任意位置可用，直接在 <uv_vertex> 处取值，
      // 不经过 varying，彻底消除先读后写。
      shader.vertexShader =
        "uniform vec2 rhinePrintGrid;\nattribute vec2 aPrintOffset;\nattribute float aInk;\nvarying float vRhineInk;\n" +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        // 标准图集寻址：UV 缩到单格大小，再平移到该格原点
        // （aPrintOffset 由 CPU 侧逐实例写入 = 格原点，rhinePrintGrid = 列数,行数）。
        "#include <uv_vertex>\nvMapUv = vMapUv / rhinePrintGrid + aPrintOffset;\nvRhineInk = aInk;",
      );
      // 强主光下不让印面被洗白超过原图色域（demo / RhineLabDesktop 同法）。
      shader.fragmentShader =
        "uniform float rhineArrayFade;\nvarying float vRhineInk;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        // 短列重复副本墨色淡出（2026-10-17 方案 2）：把印面往纸底色收拢，
        // 与 arrayFade 的收拢目标同色（0.918,0.898,0.878），远处副本像"复印了几遍"。
        "#include <map_fragment>\ndiffuseColor.rgb = mix(vec3(0.918, 0.898, 0.878), diffuseColor.rgb, vRhineInk);",
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        // 先做淡出收拢，再保留原有的不过曝限幅。
        "outgoingLight = mix(outgoingLight, vec3(0.918, 0.898, 0.878), (1.0 - rhineArrayFade) * 0.93);\noutgoingLight = min(outgoingLight, diffuseColor.rgb);\n#include <opaque_fragment>",
      );
    };
    printMat.customProgramCacheKey = () => "archive-print-opaque-v2";
    // 墙面内容=书脊窄条：贴盖面左缘可见带（x∈[−2.5,−1.6]），z 在盖面前 0.002；
    // 中央整面版式已废（P4 定案：中央被相邻卡遮挡，结构上不可见）。
    const printGeom = new THREE.PlaneGeometry(PRINT_STRIP_W, PRINT_STRIP_H);
    printGeom.translate(PRINT_STRIP_X, PRINT_STRIP_Y, 0.079);
    this.printOffset = new THREE.InstancedBufferAttribute(
      new Float32Array(count * 2),
      2,
    ).setUsage(THREE.DynamicDrawUsage);
    printGeom.setAttribute("aPrintOffset", this.printOffset);
    // 短列重复副本的逐实例墨色（1=全浓度）。初值 1：未显式写入的槽不淡出。
    this.printInk = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1)
      .setUsage(THREE.DynamicDrawUsage);
    printGeom.setAttribute("aInk", this.printInk);
    this.inkUpdates = new InstanceUpdates(this.printInk);
    const printInst = new THREE.InstancedMesh(printGeom, printMat, count);
    printInst.instanceMatrix = this.instances[0]?.instanceMatrix ?? printInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    printInst.receiveShadow = true;
    printInst.frustumCulled = false;
    this.instances.push(printInst);
    this.scene.add(printInst);
    // 竖版标签贴花：_measure_parts 实测印刷区 x[-1.48,-0.69] y[3.83,4.39]；
    // 2026-10-16 用户「两张卡片的左侧理应对齐」——贴花左缘与详情卡面（detailFace
    // 左缘 -1.7）对齐，故中心 x = -1.7 + 0.79/2 = -1.305（原 -1.085 偏右 0.22）。
    // 画布同比例 1024×726，
    // 墙面态经 WALL_SX/WALL_SY 补偿后 ≈0.99×0.41 @ (-1.36,3.04)（宽度精确还原）。
    this.labelCanvas.width = 1024;
    this.labelCanvas.height = 726;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy =
      this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.79, 0.56),
      new THREE.MeshBasicMaterial({
        map: this.labelTexture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    label.name = "card-label";
    label.position.set(-1.305, 4.11, CARD_FACE_Z);
    this.model.add(label);
    // —— B：详情/抽出卡正面完整内容面（P4 方案 C 的第二半）——
    // 抽出卡转正后整面朝向相机；版式避开左上贴花（贴花 y≥2.81），内容面只铺其下方。
    const faceCanvas = document.createElement("canvas");
    faceCanvas.width = 936;
    faceCanvas.height = 963;
    this.detailFaceCanvas = faceCanvas;
    this.detailFaceTexture = new THREE.CanvasTexture(faceCanvas);
    this.detailFaceTexture.colorSpace = THREE.SRGBColorSpace;
    this.detailFaceTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const detailFace = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.5),
      new THREE.MeshBasicMaterial({
        map: this.detailFaceTexture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    detailFace.name = "card-face";
    detailFace.position.set(0, 2.05, CARD_FACE_Z + 0.001);
    this.detailFace = detailFace;
    this.model.add(detailFace);
    this.drawDetailFace(0);
    this.appearance.prepare(this.model);
    this.appearance.apply(this.model, 0);
    this.drawLabel(0);    this.scene.add(this.model);
    this.model.position.copy(this.cellPosition(poolCell(this.selectedSlot)));
    this.loaded = true;
  }

  private assemblyTemplate?: Promise<THREE.Group>;
  async createAssemblyModel() {
    this.assemblyTemplate ??= new GLTFLoader()
      .loadAsync(publicAsset("assets/archive-assembly.glb"))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.assemblyTemplate = undefined;
        throw error;
      });
    const template = await this.assemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = (object.material as THREE.Material).name.replace(
        /\.\d+$/,
        "",
      );
      const mesh = new THREE.Mesh(
        object.geometry.clone().applyMatrix4(object.matrixWorld),
        object.material,
      );
      mesh.userData.surface = name;
      mesh.userData.assemblyPart = object.userData.assemblyPart;
      model.add(mesh);
      meshes.push(mesh);
    });
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, this.decryption.clarity);
    this.appearance.setTheme(model, this.themeAmount);
    const canvas = document.createElement("canvas");
    canvas.width = this.labelCanvas.width;
    canvas.height = this.labelCanvas.height;
    canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.99, 0.46),
      new THREE.MeshBasicMaterial({
        map: texture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    label.position.set(-1.36, 3.04, CARD_FACE_Z);
    label.userData.assemblyPart = "cover";
    label.userData.themeAmount = themeMaterial(label.material, "Printed_Canvas");
    label.userData.themeAmount.value = this.themeAmount;
    model.add(label);
    meshes.push(label);
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        texture.dispose();
      },
    };
  }
  setMode(mode: "hidden" | "archive" | "detail") {
    const previousMode = this.mode;
    this.mode = mode;
    this.cancelPointer();
    this.setHover(null);
    if (mode === "detail") this.decryption.enter(this.scanBlend > .9 && this.decryption.clarity > .999);
    else this.decryption.leave();
    if (mode === "hidden") this.decryption.select();
    if (mode !== "archive") this.pendingPulse = null;
    this.looping = mode !== "hidden";
    // 详情态提清（2026-10-15）：详情态阵列已裁半（317→154 卡），性能有富余；
    // 进入/离开 detail 时按模式重算渲染缓冲——进 detail 用大预算买分辨率，回阵列恢复正常。
    if (previousMode !== mode && (mode === "detail" || previousMode === "detail")) this.resize();
    if (!this.looping) {
      const canonical = fileLocation(fileAtSlot(this.selectedSlot));
      this.selectedCell = { lane: canonical.lane, row: canonical.row };
      this.coordinateOrigin = { lane: 0, row: 0 };
      for (const old of this.outgoing) {
        this.scene.remove(old.group);
        this.appearance.dispose(old.group);
      }
      this.outgoing = [];
    }
    this.lastInteraction = this.clock;
    this.targetReveal = mode === "hidden" ? 0 : 1;
    this.targetDetail = mode === "detail" ? 1 : 0;
    this.dragging = false;
    if (mode !== "detail") {
      this.targetRotation = 0;
      if (this.rotation !== 0) this.returnY = this.model.position.y;
    } else this.returnY = null;
  }
  /** 详情态提清档位（0 常规 / 1 半清 / 2 全清）；切换后重算渲染缓冲（detail 态才生效）。 */
  setDetailBoostLevel(level: number) {
    const value = Math.max(0, Math.min(2, Math.round(level)));
    if (this.detailBoostLevel === value) return;
    this.detailBoostLevel = value;
    if (this.mode === "detail") this.resize();
  }
  setReduced(value: boolean) {
    if (value && !this.reduced) this.cancelPointer();
    this.reduced = value;
  }
  setQuality(value: RenderQuality | boolean) {
    const quality =
      typeof value === "boolean"
        ? normalizeQuality(undefined, value)
        : normalizeQuality(value);
    const key = JSON.stringify(quality);
    if (this.appliedQuality === key) return;
    this.appliedQuality = key;
    this.quality = quality;
    if (quality.aoSamples && quality.aoSamples !== this.aoKernelSize) {
      const old = this.ao;
      this.ao = new SSAOPass(this.scene, this.camera, 1, 1, quality.aoSamples);
      this.ao.kernelRadius = old.kernelRadius;
      this.ao.minDistance = old.minDistance;
      this.ao.maxDistance = old.maxDistance;
      const index = this.composer.passes.indexOf(old);
      this.composer.removePass(old);
      this.composer.insertPass(this.ao, index);
      old.dispose();
      this.aoKernelSize = quality.aoSamples;
    }
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    this.smaa.enabled = quality.antialias === "smaa";
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(
      quality.shadows || 1024,
      this.renderer.capabilities.maxTextureSize,
    );
    if (this.light.shadow.mapSize.x !== size) {
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
      this.light.shadow.mapSize.set(size, size);
    }
    this.light.shadow.needsUpdate = true;
    applyTextureQuality(this.scene, this.renderer, quality);
    this.resize();
  }
  private cellPosition(cell: ArchiveCell) {
    return new THREE.Vector3(
      (cell.lane - 2) * COLUMN_SPACING,
      -4.6,
      (cell.row - 15.5) * ROW_SPACING,
    );
  }
  private rebaseCoordinates() {
    // Periodically reduce the logical coordinates while preserving every
    // relative position, spring velocity, ripple and idle phase.
    const shift = {
      lane:
        Math.abs(this.selectedCell.lane) > 2048
          ? Math.round((this.selectedCell.lane - 2) / 5) * 5
          : 0,
      row:
        Math.abs(this.selectedCell.row) > 2048
          ? Math.floor((this.selectedCell.row - 12) / 8) * 8
          : 0,
    };
    if (!shift.lane && !shift.row) return;
    this.setHover(null);
    this.hoverLifts.clear();
    this.selectedCell.lane -= shift.lane;
    this.selectedCell.row -= shift.row;
    this.coordinateOrigin.lane += shift.lane;
    this.coordinateOrigin.row += shift.row;
    this.laneFocus.value -= shift.lane;
    this.shoulder.value -= shift.row;
    this.columnCamera.value -= shift.lane * COLUMN_SPACING;
    this.rail.value += shift.row * ROW_SPACING;
    for (const old of this.outgoing) {
      old.cell.lane -= shift.lane;
      old.cell.row -= shift.row;
    }
    for (const pulse of this.pulses) {
      pulse.lane -= shift.lane;
      pulse.row -= shift.row;
    }
    if (this.pendingPulse) {
      this.pendingPulse.lane -= shift.lane;
      this.pendingPulse.row -= shift.row;
    }
  }
  /** 目录切换后重绘卡片内容面图集（records / archiveColumns 是原地变更的，
   *  图集与行数须按新记录集重建；UV 偏移在下一帧 update 里自动重写）。 */
  refreshContentAtlas() {
    if (!this.printCanvas || !this.printTexture) return;
    const rows = Math.max(1, Math.ceil(records.length / PRINT_ATLAS_COLS));
    // uniform 驱动 UV 归一化：行数变化只需改 uniform + 重建画布，无需重编译。
    this.printAtlasRows = rows;
    this.printGrid.value.set(PRINT_ATLAS_COLS, rows);
    this.printCanvas.height = rows * PRINT_CELL_H;
    drawPrintAtlas(this.printCanvas, records);
    this.rebindPrintTexture();
    this.drawSpineThumbs();
  }
  /** 图集重传（2026-10-17 实测定位「真机阵列只有抽起那张有图、背景卡全空白」第二根因）：
   *  关 mipmap 后 needsUpdate=true 不再把画布新像素推上 GPU —— 旧代码 mips 开着时
   *  上传路径总是全量重传，掩盖了这一点；v8.9 的缩略图补画因此永远留在 CPU 侧
   *  （实测：根目录 navy 11，换新纹理对象后 102720）。CanvasTexture 没有别的可靠
   *  失效方式，唯一稳妥做法：换一个新的 CanvasTexture 重绑材质 map，并释放旧纹理。 */
  private rebindPrintTexture() {
    if (!this.printCanvas || !this.printMaterial) return;
    const old = this.printTexture;
    const t = new THREE.CanvasTexture(this.printCanvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.anisotropy = 1;
    t.userData.keepFiltering = true;
    this.printMaterial.map = t;
    this.printTexture = t;
    // 性能档的 fastMaterial 是 clone，map 还指着旧纹理 —— 必须同步重指，
    // 否则切换性能档后打印批次渲染在已 dispose 的旧纹理上。
    for (const inst of this.instances) {
      for (const key of ["fullMaterial", "fastMaterial"] as const) {
        const m = inst.userData[key] as THREE.Material | undefined;
        if (m && (m as THREE.MeshLambertMaterial).map === old) (m as THREE.MeshLambertMaterial).map = t;
      }
      const live = inst.material as THREE.MeshLambertMaterial | null;
      if (live && (live as THREE.MeshLambertMaterial).map === old) (live as THREE.MeshLambertMaterial).map = t;
    }
    old?.dispose();
  }
  /** 墙书脊缩略图（2026-10-16 用户「在阵列状态下看不到吗」→「还是不太明显」）：带首图的
   *  档案在书脊格顶部画 cover 裁切图（x10..118 / y16..300，占格高 63%，带细描边），
   *  下方只留标题文字；无图档案书脊保持纯文字。异步补画，与详情卡共用 faceImages 缓存；
   *  目录切换重绘图集后须再调一次。 */
  private drawSpineThumbs() {
    const canvas = this.printCanvas;
    const texture = this.printTexture;
    if (!canvas || !texture) return;
    const generation = ++this.spineThumbGeneration;
    records.forEach((rec, i) => {
      if (!rec.imageUrl) return;
      const x0 = (i % PRINT_ATLAS_COLS) * PRINT_CELL_W;
      const y0 = Math.floor(i / PRINT_ATLAS_COLS) * PRINT_CELL_H;
      const url = rec.imageUrl;
      void this.loadFaceImage(url).then((img) => {
        // 图集可能已按新目录重绘（下标失效）或档案已无图：过期补画直接丢弃。
        // ⚠ 不能比较纹理对象：补画完成后的 rebindPrintTexture 会换掉 printTexture，
        // 多张图记录会互相把对方的回调判成过期（generation 才是过期信号）。
        if (!img || generation !== this.spineThumbGeneration || !this.printCanvas) return;
        if (records[i]?.imageUrl !== url) return;
        const ctx = this.printCanvas.getContext("2d")!;
        // 图占格顶 y16..276（格高 448 的 58%；旧 108 方块只有 24%，阵列远看认不出图），
        // 下方 y286..430 留给标题竖排文字带（见 drawPrintAtlas）。
        const bx = x0 + 10;
        const by = y0 + 16;
        const bw = PRINT_CELL_W - 20;
        const bh = 260;
        const scale = Math.max(bw / img.width, bh / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        ctx.drawImage(img, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
        ctx.restore();
        ctx.strokeStyle = "rgba(23, 23, 19, 0.25)";
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);
        // 补画完成 → 重绑纹理把新像素推上 GPU（needsUpdate 在 mipmap 关闭后不可靠，
        // 见 rebindPrintTexture 注释；实测根目录缩略图 needsUpdate 后 navy 仅 11）。
        this.rebindPrintTexture();
      });
    });
  }
  private spineThumbGeneration = 0;
  select(index: number, navigation?: ArchiveNavigation) {
    if (!this.navigatingDrag) this.cancelPointer();
    this.setHover(null);
    this.lastInteraction = this.clock;
    const next = fileLocation(index).slot;
    const canonical = fileLocation(index);
    const cell = this.looping
      ? selectionCell(index, this.selectedCell, navigation)
      : { lane: canonical.lane, row: canonical.row };
    const changed = !sameCell(cell, this.selectedCell);
    if (this.looping && changed && this.loaded && this.lift.value > 0.0001) {
      const group = this.model.clone(true);
      // 冻结当前贴花与内容面纹理（抽出卡归位期间保持旧档案画面）：
      // 子对象顺序=label、detailFace（load() 里最后 add），按 name 定位而非位置索引。
      const label = group.children.find((o) => o.name === "card-label") as THREE.Mesh | undefined;
      const face = group.children.find((o) => o.name === "card-face") as THREE.Mesh | undefined;
      const freeze = (mesh: THREE.Mesh | undefined, src: HTMLCanvasElement) => {
        if (!mesh) return;
        const canvas = document.createElement("canvas");
        canvas.width = src.width;
        canvas.height = src.height;
        canvas.getContext("2d")!.drawImage(src, 0, 0);
        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        mesh.material = new THREE.MeshBasicMaterial({
          map,
          toneMapped: false,
          transparent: true,
          depthWrite: false,
        });
      };
      if (label) freeze(label, this.labelCanvas);
      if (face && this.detailFaceCanvas) freeze(face, this.detailFaceCanvas);
      // Clone carries the selected label material by reference. Replace it
      // before installing appearance shaders, so theme hooks are not appended
      // to the original label a second time on every selection.
      this.appearance.prepare(group);
      this.appearance.apply(group, ease(this.lift.value / 0.4));
      this.appearance.setClarity(group, this.decryption.clarity);
      this.scene.add(group);
      this.outgoing.push({
        group,
        slot: this.selectedSlot,
        cell: { ...this.selectedCell },
        lift: { ...this.lift },
        returnY: group.rotation.y !== 0 ? group.position.y : null,
        clarity: this.decryption.clarity,
      });
      this.lift.value = 0;
      this.lift.velocity = 0;
    }
    this.selectedSlot = next;
    this.selectedCell = cell;
    if (changed) {
      this.decryption.select();
      this.rotation = 0;
      this.returnY = null;
    }
    const returning = this.outgoing.findIndex((o) => sameCell(o.cell, cell));
    if (returning >= 0) {
      const o = this.outgoing[returning];
      this.lift = { ...o.lift };
      this.rotation = o.group.rotation.y;
      this.returnY = o.returnY;
      this.decryption.select(o.clarity);
      this.scene.remove(o.group);
      this.appearance.dispose(o.group);
      this.outgoing.splice(returning, 1);
    }
    if (this.deferSelectionPulse) {
      this.pendingPulse = this.looping ? { ...cell } : null;
    } else this.emitPulse(cell);
    this.targetRotation = 0;
    this.drawLabel(index);
    this.drawDetailFace(index);
  }
  private emitPulse(cell: ArchiveCell) {
    this.pulses.push({ ...cell, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }
  private drawLabel(index: number) {
    if (!this.labelTexture) return;
    const record = records[index];
    // 列名已含完整目录层级（原始记录 / 工作记录），贴花不再拼接 department 以免重复
    const category = record ? record.category : "INTERNAL DATABASE";
    const title = record ? record.title : galleryName;
    const truncate = (text: string, limit: number) =>
      text.length > limit ? text.slice(0, limit - 1) + "…" : text;
    const c = this.labelCanvas.getContext("2d")!;
    // 竖版 1024×726（0.79:0.56 同比例）：字号 ×1.25 保持物理字高，
    // y 坐标 ×1.65 随画布高度铺开；右栏贴右缘重排。
    c.fillStyle = "#e6e2d9";
    c.fillRect(0, 0, 1024, 726);
    c.fillStyle = "#171713";
    c.fillRect(12, 14, 1000, 8);
    c.fillRect(12, 704, 1000, 6);
    c.font = "bold 101px MiSans, Noto Sans SC";
    c.fillText(`${galleryName}, LLC.`, 26, 191);
    c.font = "40px MiSans, Noto Sans SC";
    c.fillStyle = "#878476";
    c.fillText(truncate(category, 24), 28, 287);
    c.fillStyle = "#171713";
    c.font = "bold 90px MiSans, Noto Sans SC";
    c.fillText(truncate(title, 10), 26, 482);
    c.font = "bold 68px MiSans, Noto Sans SC";
    c.fillStyle = "#878476";
    c.fillText("NO." + String(index + 1).padStart(3, "0"), 26, 627);
    c.fillRect(727, 53, 276, 49);
    c.fillStyle = "#eee9de";
    c.font = "30px MiSans, Noto Sans SC";
    c.fillText("R L / I S", 761, 101);
    c.fillStyle = "#171713";
    c.font = "bold 80px MiSans, Noto Sans SC";
    // INFO 下移到公司名下方空带：竖版标签比横版窄，公司名 101px 占满行宽，
    // 原位 (787,236) 与公司名同带视觉相撞似叠字（实测 2026-10-16）。
    c.fillText("INFO", 787, 340);
    c.drawImage(this.labelMark, 740, 399, 262, 122);
    this.labelTexture.needsUpdate = true;
  }
  /** 详情/抽出卡正面的完整档案版式（P4 方案 C 的 B 半）：
   *  编号 / 标题 / 分类 / 日期 四行 + 摘要，铺满贴花下方整面。 */
  private drawDetailFace(index: number) {
    if (!this.detailFaceTexture || !this.detailFaceCanvas) return;
    const record = records[index];
    this.detailFaceIndex = index;
    const truncate = (text: string, limit: number) =>
      text.length > limit ? text.slice(0, limit - 1) + "…" : text;
    const c = this.detailFaceCanvas.getContext("2d")!;
    const W = this.detailFaceCanvas.width;
    const H = this.detailFaceCanvas.height;
    c.clearRect(0, 0, W, H);
    // 全不透明纸底（2026-10-16 用户裁定「保持内容页的不透明度」）：旧 0.88 让
    // 12% 下层磨砂奶白透出，黑字被稀释发灰＝「蒙一层」感的主要来源。
    c.fillStyle = "rgba(230, 226, 217, 1)";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "#171713";
    c.fillRect(24, 20, W - 48, 5);
    c.fillRect(24, H - 26, W - 48, 3);
    // 编号降为小字前缀，文件名为主标题（用户 2026-10-15 裁定「换过来」）。
    // 竖版画布 936×963（3.4:3.5 同比例，≈275px/单位）：摘要从 4 行增至 8 行。
    c.font = "500 34px MiSans, Noto Sans SC";
    c.fillStyle = "#8b8474";
    c.fillText(record ? truncate(record.id, 10) : "X-000", 40, 110);
    c.font = "700 84px MiSans, Noto Sans SC";
    c.fillStyle = "#171713";
    c.fillText(record ? truncate(record.title, 10) : galleryName, 40, 232);
    c.fillStyle = "#878476";
    c.fillRect(40, 292, W - 80, 3);
    // 封面变体（2026-10-16 用户裁定「有图的直接显示图就好，不用再显示文字」；同日
    // 追加「直接到绿色这，不要『本层档案』这些显示」→ 图片卡跳过分类/日期两行，图带
    // 上提到标题分隔线 y292 正下方；无图 → 文字卡：分类/日期 + 摘要 8 行照旧）。
    const hasImage = Boolean(record?.imageUrl);
    if (!hasImage) {
      c.font = "500 42px MiSans, Noto Sans SC";
      c.fillText(record ? truncate(record.category, 20) : "INTERNAL DATABASE", 40, 362);
      c.globalAlpha = 0.72;
      c.font = "500 34px MiSans, Noto Sans SC";
      const date = record ? record.date : "";
      const en = record?.en ? " · " + truncate(record.en, 18) : "";
      c.fillText(date + en, 40, 428);
      c.globalAlpha = 1;
    }
    if (!hasImage && record?.abstract) {
      c.font = "400 32px MiSans, Noto Sans SC";
      c.fillStyle = "#3c3a33";
      const words = record.abstract;
      const perLine = 26;
      for (let line = 0; line < 8; line++) {
        const seg = words.slice(line * perLine, (line + 1) * perLine);
        if (!seg) break;
        c.fillText(seg, 40, 500 + line * 52);
      }
    }
    if (hasImage) {
      // 图带上提到标题分隔线（y292+3）下方：只留编号/标题作身份，图占满余下整面。
      const bandY = 302;
      const bandH = 614;
      c.fillStyle = "#ddd6c9";
      c.fillRect(40, bandY, W - 80, bandH);
      const url = record!.imageUrl!;
      this.loadFaceImage(url).then((img) => {
        // 异步回来时档案可能已切走：仅当当前档案仍是同一张图才补画。
        if (!img || records[this.detailFaceIndex]?.imageUrl !== url || !this.detailFaceCanvas || !this.detailFaceTexture) return;
        const cc = this.detailFaceCanvas.getContext("2d")!;
        cc.save();
        cc.beginPath();
        cc.rect(40, bandY, W - 80, bandH);
        cc.clip();
        const scale = Math.max((W - 80) / img.width, bandH / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        cc.drawImage(img, 40 + ((W - 80) - dw) / 2, bandY + (bandH - dh) / 2, dw, dh);
        cc.restore();
        cc.strokeStyle = "rgba(23, 23, 19, 0.25)";
        cc.lineWidth = 2;
        cc.strokeRect(40, bandY, W - 80, bandH);
        this.detailFaceTexture.needsUpdate = true;
      });
    }
    this.detailFaceTexture.needsUpdate = true;
  }
  /** 详情卡封面图缓存：url → 加载 Promise（失败=null，不重试不刷屏）。 */
  private faceImages = new Map<string, Promise<HTMLImageElement | null>>();
  private detailFaceIndex = 0;
  private loadFaceImage(url: string): Promise<HTMLImageElement | null> {
    let pending = this.faceImages.get(url);
    if (!pending) {
      pending = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      });
      this.faceImages.set(url, pending);
    }
    return pending;
  }
  private ensureInstanceCapacity(required: number) {
    if (required <= this.instanceCapacity) return;
    const capacity = Math.max(required, this.instanceCapacity * 2);
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
    matrix.array.set(this.instances[0].instanceMatrix.array);
    for (const inst of this.instances) {
      inst.dispose();
      inst.instanceMatrix = matrix;
    }
    const previousTheme = this.themeAttribute;
    this.themeAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    if (previousTheme) this.themeAttribute.array.set(previousTheme.array);
    // aPrintOffset 同步扩容：漏掉它会让内容面批次的实例缓冲停留在初始容量，
    // 而 draw call 请求更多实例 → D3D11 ANGLE reserveSpaceForAttrib
    // GL_INVALID_OPERATION → 整批静默弃画（demo 已实证的坑，务必同步）。
    const previousPrint = this.printOffset;
    this.printOffset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    if (previousPrint) this.printOffset.array.set(previousPrint.array.subarray(0, Math.min(previousPrint.array.length, this.printOffset.array.length)));
    // aInk 同步扩容（同 aPrintOffset 的坑：不同步会整批弃画）。新槽填 1=不淡出。
    const previousInk = this.printInk;
    this.printInk = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    if (previousInk) this.printInk.array.set(previousInk.array.subarray(0, Math.min(previousInk.array.length, this.printInk.array.length)));
    for (const inst of this.instances) {
      inst.geometry.setAttribute("archiveTheme", this.themeAttribute);
      if (inst.geometry.getAttribute("aPrintOffset")) inst.geometry.setAttribute("aPrintOffset", this.printOffset);
      if (inst.geometry.getAttribute("aInk")) inst.geometry.setAttribute("aInk", this.printInk);
    }
    this.matrixUpdates = new InstanceUpdates(matrix);
    this.themeUpdates = new InstanceUpdates(this.themeAttribute);
    this.printUpdates = new InstanceUpdates(this.printOffset);
    this.inkUpdates = new InstanceUpdates(this.printInk);
    this.instanceCapacity = capacity;
  }
  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    // 视图被隐藏（切标签/开新标签）时容器尺寸为 0：此时任何尺寸换算都会产出
    // Infinity/NaN，一旦写进相机就再也回不来。宁可跳过，等真正可见时再算。
    if (w <= 0 || h <= 0) return;
    const kind = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "";
    const displayHeight = this.container.getBoundingClientRect().height;
    if (this.layoutKind === "cinematic" && kind !== "cinematic" && this.displayHeight > 0) {
      // Removing letterboxing starts from the same apparent model size. The
      // existing camera interpolation then carries it to the responsive anchor.
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * displayHeight / this.displayHeight,
      ));
    }
    this.displayHeight = displayHeight;
    this.layoutKind = kind;
    // 详情态提清：仅 detail 态且档位>0 时，用大预算 + scale 补偿买回分辨率。
    // 2=全清（2.07MP≈1080p）；1=半清（1.33MP≈1536×864，帧率约 1.5×）。
    const boostLevel = this.mode === "detail" ? this.detailBoostLevel : 0;
    const boosting = boostLevel > 0;
    const boostQuality = boosting
      ? {
          ...this.quality,
          scale: Math.max(this.quality.scale, ArchiveScene.DETAIL_BOOST_SCALE),
          // 高 DPI 屏（如 125% 缩放）上性能档 pixelRatio=1 把缓冲封顶在 CSS 分辨率，
          // 拉伸到物理像素=整体发糊（用户 2026-10-16「就还是指详情页，感觉高斯模糊在」）。
          // 详情提清必须把 pixelRatio 至少买回设备 DPR：半清预算 1.33MP 恰好容纳
          // 1536×864@1.25，不超预算不亏帧率；100% 屏（DPR=1）行为不变。
          pixelRatio: Math.max(this.quality.pixelRatio, devicePixelRatio),
        }
      : this.quality;
    const dimensions = resizeQuality(
      this.renderer,
      this.composer,
      this.container,
      boostQuality,
      this.superPerformance,
      boosting
        ? boostLevel === 2
          ? ArchiveScene.DETAIL_BOOST_BUDGET
          : ArchiveScene.DETAIL_BOOST_MID_BUDGET
        : undefined,
    );
    this.ao.setSize(
      Math.max(1, Math.floor(dimensions.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(dimensions.height * this.quality.aoResolution)),
    );
    this.container.dataset.renderQuality = JSON.stringify({
      ...JSON.parse(this.container.dataset.renderQuality!),
      aoSamples: this.ao.enabled ? this.aoKernelSize : 0,
      aoWidth: this.ao.width,
      aoHeight: this.ao.height,
      shadows: this.renderer.shadowMap.enabled
        ? this.light.shadow.mapSize.x
        : 0,
      depthOfField: this.bokeh.enabled ? this.quality.depthOfField : 0,
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // setSize / composer.setSize 会重建绘制缓冲并清空画布；侧栏收起/展开时 iframe 宽度
    // 逐帧变化，只等下一帧 rAF 重绘会露出 1~3 帧空画面（用户看到的「屏闪」）。
    // 这里在尺寸落定后立即补画一帧，保证宽度动画期间画布始终有内容。
    try {
      this.scene.updateMatrixWorld();
      this.renderer.shadowMap.needsUpdate = true;
      if (this.superPerformance) this.renderer.render(this.scene, this.camera);
      else this.composer.render();
    } catch {
      // 初始化早期/上下文丢失时忽略，交给正常渲染循环处理。
    }
  }
  /** 数值体检：NaN/Infinity 一旦进入相机（瞄准点/位置/投影矩阵），插值会永久传染，
   *  表现为"三维画面凭空消失，而 DOM、上下文、帧率全都正常"。 */
  get healthy() {
    const finite = (v: THREE.Vector3) =>
      Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    const aspect = this.camera.aspect;
    return (
      finite(this.camera.position) &&
      finite(this.cameraAim) &&
      finite(this.model.position) &&
      Number.isFinite(aspect) &&
      aspect > 0 &&
      Number.isFinite(this.camera.fov) &&
      this.camera.projectionMatrix.elements.every((n) => Number.isFinite(n))
    );
  }

  /** 复位到构造时的已知良好状态（随后各帧的插值会把镜头带回归属取景）。 */
  repair() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (!Number.isFinite(this.model.position.x)) this.model.position.set(0, 0, 0);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.camera.fov = 6.15;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.cameraAim);
  }

  private canBrowse() {
    return (
      this.presenceTarget === 1 &&
      this.looping &&
      !this.targetDetail &&
      this.detail < 0.2 &&
      this.reveal >= 0.8 &&
      this.loaded &&
      !this.container.closest("[inert]")
    );
  }
  private setHover(cell: ArchiveCell | null) {
    if (
      (!cell && !this.hoverCell) ||
      (cell && this.hoverCell && sameCell(cell, this.hoverCell))
    )
      return;
    this.hoverCell = cell ? { ...cell } : null;
    this.onHover?.(cell ? fileAtCell(cell) : null);
  }
  private pickCell(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.cursor.set(
      ((x - r.left) / r.width) * 2 - 1,
      (-(y - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.cursor, this.camera);
    const hit = this.raycaster.intersectObjects(
      [this.instances[0], this.model, ...this.outgoing.map((o) => o.group)],
      true,
    )[0];
    if (!hit) return null;
    if (hit.instanceId !== undefined) return { ...this.drawnCells[hit.instanceId] };
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      const copy = this.outgoing.find((o) => o.group === object);
      if (copy) return { ...copy.cell };
      object = object.parent;
    }
    return { ...this.selectedCell };
  }
  private trackCoordinate(axis: DragAxis, value: number) {
    return axis === "lane"
      ? value / COLUMN_SPACING + 2
      : (-value - 2.17) / ROW_SPACING + 15.5;
  }
  private dragProjection(): DragProjection {
    this.model.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const center = this.model.localToWorld(new THREE.Vector3(0, CARD_H / 2, 0));
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (motion: THREE.Vector3) => {
      const from = center
        .clone()
        .addScaledVector(motion, -0.5)
        .project(this.camera);
      const to = center
        .clone()
        .addScaledVector(motion, 0.5)
        .project(this.camera);
      return {
        x: ((to.x - from.x) * rect.width) / 2,
        y: (-(to.y - from.y) * rect.height) / 2,
      };
    };
    // Positive navigation moves the array along -X for columns and -Z for rows.
    return {
      lane: project(new THREE.Vector3(-COLUMN_SPACING, 0, 0)),
      row: project(new THREE.Vector3(0, 0, -ROW_SPACING)),
    };
  }
  private trackPosition(axis: DragAxis, coordinate: number) {
    return axis === "lane"
      ? (coordinate - 2) * COLUMN_SPACING
      : -2.17 - (coordinate - 15.5) * ROW_SPACING;
  }
  private navigatePlane(coordinate: DragPosition) {
    const goal = { lane: Math.round(coordinate.lane), row: Math.round(coordinate.row) };
    if (sameCell(goal, this.selectedCell)) return;
    const from = { ...this.selectedCell };
    const steps = Math.min(64, Math.max(Math.abs(goal.lane - from.lane), Math.abs(goal.row - from.row)));
    this.navigatingDrag = true;
    try {
      // Select physical cells along the travelled segment in one update per cell.
      // Column memory is updated by onSelect, but never pulls a held plane away.
      for (let i = 1; i <= steps; i++) {
        const cell = {
          lane: Math.round(from.lane + (goal.lane - from.lane) * i / steps),
          row: Math.round(from.row + (goal.row - from.row) * i / steps),
        };
        if (!sameCell(cell, this.selectedCell)) this.onSelect?.(fileAtCell(cell), cell);
      }
    } finally {
      this.navigatingDrag = false;
    }
  }
  private stopMomentum() {
    if (this.archiveMomentum) {
      this.columnCamera.velocity = 0;
      this.rail.velocity = 0;
    }
    this.archiveMomentum = null;
  }
  private bindPointer() {
    const canvas = this.renderer.domElement;
    let activePointer: number | null = null;
    let previousX = 0,
      startX = 0,
      startY = 0,
      moved = false;
    let browse = false,
      cancelled = false;
    let startTrack = { lane: 0, row: 0 };
    let wheelTotal = 0,
      wheelTime = 0;
    const pointers = new Set<number>();
    const hover = (e: PointerEvent) => {
      if (
        e.pointerType !== "mouse" ||
        !this.canBrowse() ||
        this.archiveMomentum
      )
        return;
      const r = canvas.getBoundingClientRect();
      this.pointer.set(
        (e.clientX - r.left) / r.width - 0.5,
        (e.clientY - r.top) / r.height - 0.5,
      );
      const cell = this.pickCell(e.clientX, e.clientY);
      this.setHover(cell);
      canvas.style.cursor = cell ? "pointer" : "grab";
    };
    const reset = () => {
      const id = activePointer;
      activePointer = null;
      this.dragging = false;
      this.dragTrack = null;
      this.holdingArchive = false;
      browse = false;
      this.setHover(null);
      canvas.style.cursor = this.canBrowse() ? "grab" : "default";
      if (id !== null && canvas.hasPointerCapture(id))
        canvas.releasePointerCapture(id);
    };
    this.cancelPointer = () => {
      cancelled = true;
      this.stopMomentum();
      pointers.clear();
      wheelTotal = 0;
      reset();
    };
    const moveArchive = (e: PointerEvent) => {
      const pending = !this.archiveDrag.active;
      for (const sample of e.getCoalescedEvents?.() ?? []) {
        this.archiveDrag.move(sample.clientX, sample.clientY, sample.timeStamp);
      }
      this.archiveDrag.move(e.clientX, e.clientY, e.timeStamp);
      moved ||= this.archiveDrag.moved;
      if (!this.archiveDrag.active) return;
      if (pending) {
        startTrack = { lane: this.columnCamera.value, row: this.rail.value };
      }
      this.setHover(null);
      this.lastInteraction = this.clock;
      canvas.style.cursor = "grabbing";
      this.dragTrack = {
        lane: startTrack.lane + this.archiveDrag.value.lane * COLUMN_SPACING,
        row: startTrack.row - this.archiveDrag.value.row * ROW_SPACING,
      };
      this.columnCamera.value = this.dragTrack.lane;
      this.rail.value = this.dragTrack.row;
      this.columnCamera.velocity = this.rail.velocity = 0;
      this.navigatePlane({
        lane: this.trackCoordinate("lane", this.columnCamera.value),
        row: this.trackCoordinate("row", this.rail.value),
      });
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!this.canBrowse() && !this.canInspect) return;
      pointers.add(e.pointerId);
      if (pointers.size > 1) {
        cancelled = true;
        reset();
        return;
      }
      activePointer = e.pointerId;
      cancelled = false;
      moved = this.archiveMomentum !== null;
      startX = previousX = e.clientX;
      startY = e.clientY;
      browse = this.canBrowse();
      this.stopMomentum();
      if (browse) {
        this.columnCamera.velocity = 0;
        this.rail.velocity = 0;
      }
      this.holdingArchive = browse;
      this.dragging = !browse && this.canInspect;
      startTrack = { lane: this.columnCamera.value, row: this.rail.value };
      this.archiveDrag.start(e.clientX, e.clientY, this.dragProjection(), e.timeStamp);
      this.setHover(null);
      canvas.setPointerCapture(e.pointerId);
      if (this.relayActive) { this.holdingArchive = false; this.dragging = false; }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointermove", (e) => {
      if (this.relayActive) {
        if (e.pointerId === activePointer) moved ||= Math.hypot(e.clientX - startX, e.clientY - startY) > 7;
        return;
      }
      if (activePointer !== null && e.pointerId !== activePointer) return;
      if (activePointer === null) {
        hover(e);
        return;
      }
      if (cancelled) return;
      moved ||= Math.hypot(e.clientX - startX, e.clientY - startY) > 7;
      if (browse) {
        if (!this.canBrowse()) {
          this.cancelPointer();
          return;
        }
        moveArchive(e);
        return;
      }
      if (this.dragging && this.canInspect) {
        this.targetRotation = THREE.MathUtils.clamp(
          this.targetRotation + (e.clientX - previousX) * 0.004,
          -0.8,
          0.8,
        );
        previousX = e.clientX;
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId !== activePointer) return;
      if (this.relayActive) {
        if (!cancelled && !moved) { const cell = this.pickCell(e.clientX, e.clientY); this.onRelayPick?.(cell ? cellKey(cell) : null); }
        reset(); return;
      }
      if (!cancelled && browse && this.canBrowse()) {
        moveArchive(e);
        if (this.archiveDrag.active) {
          if (!this.reduced) {
            this.archiveMomentum = {
              time: performance.now() / 1000,
              motion: new ArchivePlaneMomentum(
                { lane: this.trackCoordinate("lane", this.columnCamera.value), row: this.trackCoordinate("row", this.rail.value) },
                this.archiveDrag.releaseVelocity(e.timeStamp, false),
              ),
            };
          }
        } else if (!moved) {
          const cell = this.pickCell(e.clientX, e.clientY);
          if (cell) this.onSelect?.(fileAtCell(cell), cell);
        }
      }
      reset();
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) {
        cancelled = true;
        reset();
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("lostpointercapture", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) {
        cancelled = true;
        reset();
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointerleave", () => {
      this.pointer.set(0, 0);
      this.setHover(null);
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.relayActive) { e.preventDefault(); return; }
        if (
          !this.canBrowse() ||
          activePointer !== null ||
          e.ctrlKey ||
          Math.abs(e.deltaX) > Math.abs(e.deltaY)
        )
          return;
        e.preventDefault();
        if (this.archiveMomentum) this.stopMomentum();
        const now = performance.now();
        const delta = THREE.MathUtils.clamp(
          e.deltaY *
            (e.deltaMode === 1
              ? 40
              : e.deltaMode === 2
                ? canvas.clientHeight
                : 1),
          -300,
          300,
        );
        if (now - wheelTime > 180 || Math.sign(delta) !== Math.sign(wheelTotal))
          wheelTotal = 0;
        wheelTime = now;
        wheelTotal += delta;
        const steps = Math.min(3, Math.floor(Math.abs(wheelTotal) / 100));
        if (!steps) return;
        const direction = Math.sign(wheelTotal);
        wheelTotal -= direction * steps * 100;
        this.navigatingDrag = true;
        try {
          for (let i = 0; i < steps; i++) this.onNavigate?.("row", direction);
        } finally {
          this.navigatingDrag = false;
        }
      },
      { ...{ passive: false }, signal: this.inputEvents.signal },
    );
    window.addEventListener("blur", () => this.cancelPointer(), { signal: this.inputEvents.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelPointer();
    }, { signal: this.inputEvents.signal });
    window.addEventListener("resize", () => this.cancelPointer(), { signal: this.inputEvents.signal });
    // After multi-touch cancels capture, a finger can finish outside the canvas.
    window.addEventListener("pointerup", (e) => pointers.delete(e.pointerId), { signal: this.inputEvents.signal });
    window.addEventListener("pointercancel", (e) =>
      pointers.delete(e.pointerId), { signal: this.inputEvents.signal }
    );
  }
  update(
    time: number,
    cinematic?: { reveal: number; lift: number; zoom: number; time: number },
  ) {
    // 帧间隔：普通卡顿必须按真实时间积分，不能截断。
    // 2026-10-17（用户「更丝滑」目标）：原先一律 Math.min(elapsed, 0.05)，掉帧时整段
    // 动画按比例慢放——实测 200ms 长帧只积分 50ms，位移少走 18.65%，25fps 下整段运动
    // 只有正常速度的 31%，表现为「卡且发滞」。本文件的平滑全部是解析式指数/弹簧
    // （damp 与 1-exp 都是闭式解，任意 dt 都精确且无条件稳定），无需为数值稳定性截断。
    // 分界取 1s：1s 以内一律按真实时间积分——包括 700ms 的极端掉帧，因为「按墙钟推进」
    // 才是正确语义（iOS/CoreAnimation 同样按 displayLink 时间戳积分，掉帧就跳到该到的位置）。
    // 超过 1s 只可能是标签页挂起 / GL 上下文丢失后的恢复，此时整段动画早已到期，
    // 按 1s 上限积分即可，不必用 0.05 那样的小值（那等于又一次慢放）。
    const rawElapsed = Math.max(0, time - this.last || 0.016);
    const elapsed = rawElapsed > 1 ? 1 : rawElapsed;
    const dt = elapsed;
    this.last = time;
    this.clock = time;
    if (!this.loaded) return;
    const step = this.reduced ? 1 : Math.min(elapsed, .25) / 1.1;
    this.presence += Math.sign(this.presenceTarget - this.presence) * Math.min(step, Math.abs(this.presenceTarget - this.presence));
    this.renderer.domElement.style.opacity = String(THREE.MathUtils.clamp(this.presence / .16, 0, 1));
    this.theme.beginFrame();
    themeEnvironment(this.scene, this.renderer, this.themeAmount);
    const blend = 1 - Math.exp(-dt * (this.reduced ? 35 : 2.8));
    this.reveal = cinematic
      ? cinematic.reveal
      : THREE.MathUtils.lerp(this.reveal, this.targetReveal, blend);
    // 详情态墙面淡出（2026-10-15 用户裁定「淡出至隐约可见」）：detail 推进时把
    // 墙面批次向背景色收拢，最低保留 0.07 的存在感；回阵列恢复 1。电影开场不参与。
    const fadeTarget = cinematic ? 1 : THREE.MathUtils.lerp(1, 0.07, THREE.MathUtils.clamp((this.detail - 0.5) / 0.4, 0, 1));
    arrayFade.value += (fadeTarget - arrayFade.value) * (1 - Math.exp(-dt * (this.reduced ? 35 : 5)));
    // 淡到位后停止绘制阵列（2026-10-15 用户报「详情还是糊+提示降档」后的根修）：
    // 实测外壳批次（transmission 0.78）占详情态全部成本——1080p 下 8fps vs 停画 35fps；
    // 而淡出到位（fade<0.15）时"显示 vs 停画"左半屏平均色差仅 1.5%、可辨像素 1.4%。
    // 用 0.15/0.2 双阈值迟滞防边界抖动；恢复绘制时 0.2 档鬼影≈背景色，弹出不可感。
    if (!this.arrayCulled && this.mode === "detail" && !cinematic && arrayFade.value < 0.15) {
      this.arrayCulled = true;
      for (const inst of this.instances) inst.visible = false;
    } else if (this.arrayCulled && (this.mode !== "detail" || arrayFade.value > 0.2)) {
      this.arrayCulled = false;
      for (const inst of this.instances) inst.visible = true;
    }
    this.rotation = this.targetDetail
      ? THREE.MathUtils.lerp(this.rotation, this.targetRotation, blend)
      : returnStep(this.rotation, dt, this.reduced);
    const shot = cinematic?.time ?? 29.1;
    if (cinematic) {
      this.scanTime = shot;
      this.scanBlend = 1;
    } else {
      this.scanTime += dt;
      this.scanBlend *= Math.exp(-dt * 3);
    }
    if (!this.canBrowse()) {
      this.setHover(null);
      if (this.holdingArchive || this.archiveMomentum) this.cancelPointer();
    }
    if (this.looping && !cinematic && !this.holdingArchive && !this.archiveMomentum) this.rebaseCoordinates();
    const momentum = !cinematic ? this.archiveMomentum : null;
    if (momentum) {
      momentum.motion.step(Math.min(Math.max(time - momentum.time, 0), 0.25));
      momentum.time = time;
      this.navigatePlane(momentum.motion.value);
      this.lastInteraction = time;
    }
    const hoverKey = !cinematic && this.hoverCell ? cellKey(this.hoverCell) : null;
    if (hoverKey && !this.hoverLifts.has(hoverKey)) this.hoverLifts.set(hoverKey, 0);
    for (const [key, value] of this.hoverLifts) {
      const target = key === hoverKey ? 0.28 : 0;
      const next = cinematic ? 0 : this.reduced ? target : THREE.MathUtils.lerp(value, target, 1 - Math.exp(-dt * 14));
      if (target === 0 && next < 0.0001) this.hoverLifts.delete(key);
      else this.hoverLifts.set(key, next);
    }
    const hoverLift = (cell: ArchiveCell) => this.hoverLifts.get(cellKey(cell)) ?? 0;
    const chosen = this.cellPosition(this.selectedCell);
    const selectedRow = this.selectedCell.row;
    const selectedLane = this.selectedCell.lane;
    // 2026-10-17 手感层：实体升降/轨道跟随改用带轻微回弹的 dampSpring（ζ=BODY_ZETA）。
    // 衰减包络与原来完全一致，所以「到位快慢」不变，只有末梢多一下软着陆。
    dampSpring(this.shoulder, selectedRow, this.reduced ? 35 : 5, dt, this.reduced ? 1 : BODY_ZETA);
    dampSpring(this.laneFocus, selectedLane, this.reduced ? 35 : 4, dt, this.reduced ? 1 : BODY_ZETA);
    // A held or freely coasting plane owns both tracks; selection cannot pull it.
    if (!this.holdingArchive && !momentum) {
      dampSpring(this.columnCamera, chosen.x, this.reduced ? 35 : 3.7, dt, this.reduced ? 1 : BODY_ZETA);
      dampSpring(this.rail, cinematic ? 0 : -2.17 - chosen.z, this.reduced ? 35 : 3.7, dt, this.reduced ? 1 : BODY_ZETA);
    }
    if (momentum) {
      this.columnCamera.value = this.trackPosition("lane", momentum.motion.lane.value);
      this.rail.value = this.trackPosition("row", momentum.motion.row.value);
      this.columnCamera.velocity = momentum.motion.lane.velocity * COLUMN_SPACING;
      this.rail.velocity = -momentum.motion.row.velocity * ROW_SPACING;
      if (momentum.motion.phase === "idle") this.archiveMomentum = null;
    }
    if (this.dragTrack && !cinematic) {
      this.columnCamera.value = this.dragTrack.lane;
      this.rail.value = this.dragTrack.row;
      this.columnCamera.velocity = this.rail.velocity = 0;
    }
    if (cinematic) {
      this.rail.value = 0;
      this.rail.velocity = 0;
      this.lift.value = extraction(shot);
      this.lift.velocity = 0;
      this.shoulder.value = selectedRow;
      this.laneFocus.value = selectedLane;
      this.laneFocus.velocity = 0;
      this.columnCamera.value = chosen.x;
      this.columnCamera.velocity = 0;
    }
    // Keep the illuminated set near the origin. Lateral navigation is a track
    // movement of the whole array, just like the existing front/back rail.
    const trackX = cinematic ? 0 : this.columnCamera.value;
    this.pulses = this.pulses.filter((p) => time - p.time < 3.2);
    const aligningCopy = this.outgoing.some((o) => o.returnY !== null);
    const idle =
      !cinematic &&
      !this.reduced &&
      this.targetReveal > 0 &&
      !this.targetDetail &&
      this.detail < 0.01 &&
      this.returnY === null &&
      !aligningCopy &&
      time - this.lastInteraction > 2.5;
    this.idleGain = cinematic
      ? 0
      : THREE.MathUtils.lerp(
          this.idleGain,
          idle ? (this.playfield.enabled ? (this.playfield.breathing && !this.relayActive ? 1 - this.playfield.bands.activity : 0) : 1) : 0,
          1 - Math.exp(-dt * (idle ? 0.8 : 4)),
        );
    this.pulseGain = THREE.MathUtils.lerp(
      this.pulseGain,
      this.targetDetail || this.returnY !== null || aligningCopy ? 0 : 1,
      1 - Math.exp(-dt * 8),
    );
    const play = this.playfield;
    const activePlay = !cinematic && !this.targetDetail && play.enabled;
    const rhythm = this.rhythm.update(activePlay && !this.reduced ? play.bands : quietBands(), time, dt, this.rhythmStyle);
    this.flatMix += ((activePlay ? play.flatten : 0) - this.flatMix) * (this.reduced ? 1 : 1 - Math.exp(-dt * 4));
    this.subduedIndex.value = Math.max(Number(this.selectedIndexOnly), this.flatMix);
    const indexDim = (lift: number) => this.selectedIndexOnly
      ? 1 - ease(lift / .4) * (1 - this.flatMix)
      : this.flatMix;
    const gameTarget = activePlay ? play.target : null;
    if (gameTarget && !this.relayLifts.has(gameTarget)) this.relayLifts.set(gameTarget, 0);
    for (const [key, height] of this.relayLifts) {
      const next = height + ((key === gameTarget ? .95 : 0) - height) * (this.reduced ? 1 : 1 - Math.exp(-dt * 8));
      if (next < .001 && key !== gameTarget) this.relayLifts.delete(key); else this.relayLifts.set(key, next);
    }
    const spectrumPoint = new THREE.Vector3();
    const screenX = (row: number, lane: number) => {
      spectrumPoint.set((lane - 2) * COLUMN_SPACING - trackX, -4.6, (row - 15.5) * ROW_SPACING + this.rail.value).project(this.camera);
      return (spectrumPoint.x + 1) / 2;
    };
    const field = (row: number, lane: number) => {
      if (cinematic)
        return cinematicField(
          row,
          lane,
          shot,
          this.shoulder.value,
          this.laneFocus.value,
        );
      const height =
        archiveWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          this.scanTime,
        ) *
          this.scanBlend;
      const breathing = idleWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          time,
        ) *
          this.idleGain;
      let pulseHeight = 0;
      if (!cinematic && !this.reduced) {
        let ripple = 0;
        for (const p of this.pulses) {
          const distance = Math.hypot(row - p.row, (lane - p.lane) * 2.2);
          const age = time - p.time;
          ripple +=
            this.selectionPulse(distance, age) *
            (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
        }
        pulseHeight = THREE.MathUtils.clamp(ripple, -0.6, 0.6) * this.pulseGain;
      }
      const distance = row - this.shoulder.value;
      return (
        (height +
        settlingWave(distance, 26.56) *
          columnStrength(lane, this.laneFocus.value)) * (1 - this.flatMix) + breathing + pulseHeight +
        (activePlay && !this.reduced ? rhythmDisplacement(row, lane, time, play.bands, play.strength, rhythm, screenX(row, lane)) : 0) +
        (this.relayLifts.get(cellKey({ row, lane })) ?? 0)
      );
    };
    const selectedBase = chosen.y + field(selectedRow, selectedLane);
    if (!cinematic) {
      if (this.returnY !== null && this.rotation !== 0) {
        this.lift.value = this.returnY - selectedBase;
        this.lift.velocity = 0;
      } else {
        this.returnY = null;
        dampSpring(
          this.lift,
          this.targetDetail
            ? INSPECTION_LIFT
            : this.outgoing.some(
                  (o) =>
                    o.returnY !== null &&
                    o.cell.lane === selectedLane &&
                    Math.abs(o.cell.row - selectedRow) < 5,
                )
              ? 0
              : 0.4 * this.targetReveal * (1 - this.flatMix),
          this.reduced
            ? 35
            : this.deferSelectionPulse &&
                !this.targetDetail &&
                this.lift.value < 0.4
              ? 7.6
              : 4.2,
          dt,
          this.reduced ? 1 : BODY_ZETA,
        );
      }
    }
    // 抽起→详情的「衔接」：detail 原来与 reveal/rotation 共用 blend（rate 2.8），
    // 而 lift 是弹簧（rate 4.2）——串联后 detail 的 99% 到位时刻比 lift 晚 0.84s，
    // 表现为「卡片已经停住、镜头还在追」，就是用户说的衔接不流畅
    // （probe-detail-chain.mjs 实测：lift99=1.09s / detail99=1.93s）。
    // 给 detail 单独用 rate 6（probe-detail-link.mjs 扫描：gap 0.841s → -0.005s，
    // 抽起→详情的「衔接」：两处修正，合起来才对齐。
    // ① 映射区间原来只到 lift=3.2（`ease((lift-0.8)/2.4)`），而 lift 目标是 4.05：
    //    detail 在 lift 只完成 76.7% 时就已满值，剩下 23% 行程里镜头不动 —— 这是
    //    「镜头先停、卡片还在升」的真正来源。改为映射到实际行程 [0.8, INSPECTION_LIFT]，
    //    detail 与 lift 同步收敛（probe-detail-map.mjs 扫描验证）。
    // ② detail 原来与 reveal/rotation 共用 blend（rate 2.8），落后弹簧一步；
    //    改独立 rate 8 让一阶滞后与二阶弹簧同刻到位
    //    （probe-detail-link.mjs 在 11.6/30/60/120fps 下扫描：gap 0.84s → ≤0.017s）。
    // 注意不能改 blend 本身：它还驱动 reveal（入场淡入）与 rotation（预览态旋转）。
    const detailBlend = 1 - Math.exp(-dt * (this.reduced ? 35 : 8));
    const cameraTarget = this.targetDetail
      ? ease((this.lift.value - 0.8) / (INSPECTION_LIFT - 0.8))
      : this.returnY !== null
        ? this.detail
        : ease((this.lift.value - 0.4) / (INSPECTION_LIFT - 0.4));
    this.detail = cinematic
      ? cinematic.zoom
      : THREE.MathUtils.lerp(this.detail, cameraTarget, detailBlend);
    const detail = this.detail;
    this.decryption.update(dt, detail > .78 && this.lift.value > 3.3, this.reduced,
      cinematic ? shot + 5 : undefined);
    this.appearance.apply(this.model, ease(this.lift.value / 0.4));
    this.appearance.setClarity(this.model, this.decryption.clarity);
    // Reference 26.92–27.76: the array travels horizontally into a white field.
    const entry = cinematic ? ease((shot - 21.9) / 0.86) : this.reveal;
    const entranceTime = THREE.MathUtils.clamp((shot - 21.92) / 0.75, 0, 1);
    const entryZ = cinematic
      ? -23 * (1 - entranceTime) ** 2
      : -28 * (1 - entry);
    for (let i = this.outgoing.length - 1; i >= 0; i--) {
      const o = this.outgoing[i];
      const p = this.cellPosition(o.cell);
      const baseY = p.y + field(o.cell.row, o.cell.lane);
      o.group.rotation.y = returnStep(o.group.rotation.y, dt, this.reduced);
      if (o.returnY !== null) {
        o.lift.value = o.returnY - baseY;
        o.lift.velocity = 0;
        if (o.group.rotation.y === 0) o.returnY = null;
      } else dampSpring(o.lift, 0, this.reduced ? 35 : 4.5, dt, this.reduced ? 1 : BODY_ZETA);
      o.group.position.set(
        p.x - trackX,
        baseY + o.lift.value + hoverLift(o.cell) - this.presentationDrop(o.cell),
        p.z + entryZ + this.rail.value,
      );
      const quality = ease(o.lift.value / 0.4);
      this.appearance.apply(o.group, quality);
      // outgoing 克隆与 model 同步插值补偿：归位途中从墙态横显平滑接回竖版。
      const wallS = 1 - (1 - WALL_SX) * (1 - detail) ** 3;
      const wallY = 1 - (1 - WALL_SY) * (1 - detail) ** 3;
      o.group.scale.set(wallS, wallY, 1);
      this.appearance.setTheme(o.group, this.theme.sample(o.cell, time), indexDim(o.lift.value));
      o.clarity = this.reduced ? 0 : o.clarity * Math.exp(-dt * 9);
      this.appearance.setClarity(o.group, o.clarity);
      const { row, lane } = o.cell;
      o.group.rotation.x =
        (field(row + 0.5, lane) - field(row - 0.5, lane)) *
        0.024 *
        (1 - detail) *
        (1 - quality);
      if (o.lift.value < 0.0001 && Math.abs(o.group.rotation.y) < 0.0001) {
        this.scene.remove(o.group);
        this.appearance.dispose(o.group);
        this.outgoing.splice(i, 1);
      }
    }
    if (
      this.pendingPulse &&
      !cinematic &&
      !this.targetDetail &&
      this.targetReveal
    ) {
      const selectedY = selectedBase + this.lift.value;
      const oldCardsLower = this.outgoing.every(
        (old) =>
          old.cell.lane !== selectedLane ||
          Math.abs(old.cell.row - selectedRow) > 4 ||
          old.group.position.y + 0.015 < selectedY,
      );
      // The new file causes the wave: finish most of its rise and let nearby
      // outgoing files get below it before starting the outward pulse.
      if (this.lift.value >= 0.35 && this.returnY === null && oldCardsLower) {
        if (!this.reduced) this.emitPulse(this.pendingPulse);
        this.pendingPulse = null;
      }
    }
    this.appearance.setTheme(this.model, this.theme.sample(this.selectedCell, time), indexDim(this.lift.value));
    // B 路线核心插值：model 局部恒为竖版资产；detail=0 时×补偿=墙内横显，
    // detail=1 时恢复 (1,1,1) 原生竖版。所有 localToWorld 消费点自动跟随。
    const wallS = 1 - (1 - WALL_SX) * (1 - detail) ** 3;
    const wallY = 1 - (1 - WALL_SY) * (1 - detail) ** 3;
    this.model.scale.set(wallS, wallY, 1);
    this.model.position.set(
      chosen.x - trackX,
      chosen.y + field(selectedRow, selectedLane) + this.lift.value + hoverLift(this.selectedCell) - this.presentationDrop(this.selectedCell),
      chosen.z + entryZ + this.rail.value,
    );
    // Extraction only changes elevation. Reframing belongs to the camera.
    this.model.rotation.set(
      (field(selectedRow + 0.5, selectedLane) -
        field(selectedRow - 0.5, selectedLane)) *
        0.024 *
        (1 - detail) *
        (1 - ease(this.lift.value / 0.4)),
      cinematic ? 0 : this.rotation,
      0,
    );
    // Measured from frame 787: X edge (382,-204), adjacent row (78,38).
    // The label vertical edge constrains height; the file base is occluded.
    // Do not calibrate field of view from the visible fragment of a file.
    const orbit = ease((shot - 22.6) / 1.6);
    const settle = ease((shot - 24.25) / 2.25);
    const yaw = THREE.MathUtils.degToRad(89 - 22 * orbit - 8 * settle);
    const elevation = THREE.MathUtils.degToRad(
      3 + 40 * ease((shot - 21.96) / 0.22) - 8 * orbit - 16 * settle,
    );
    const span = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.8, 10.3, orbit),
      7.33,
      settle,
    );
    const responsiveOpening = Boolean(cinematic) && this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "opening";
    const openingAspect = responsiveOpening ? this.container.clientWidth / this.container.clientHeight / (16 / 9) : 1;
    const openingSpan = (value: number) => value / Math.min(1, openingAspect);
    const distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(28 + 7 * orbit, 140, settle),
      72,
      detail,
    );
    const arrayAim = new THREE.Vector3(
      -1.091,
      THREE.MathUtils.lerp(-2.55 + 0.4 * orbit, -0.045, settle),
      THREE.MathUtils.lerp(2.48, 0.481, settle),
    );
    const cameraAim = arrayAim.clone();
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    if (cinematic) {
      const earlyTurn = ease((shot - 27.3) / 1.3);
      const finalTurn = ease((shot - 28.6) / 5.4);
      const shotYaw =
        yaw - THREE.MathUtils.degToRad(9 * earlyTurn + 32 * finalTurn);
      const shotElevation =
        elevation - THREE.MathUtils.degToRad(1.5 * earlyTurn + 3.7 * finalTurn);
      viewDirection.set(
        -Math.sin(shotYaw) * Math.cos(shotElevation),
        Math.sin(shotElevation),
        Math.cos(shotYaw) * Math.cos(shotElevation),
      );
    } else {
      viewDirection
        .lerp(new THREE.Vector3(-0.277, 0.238, 0.931), detail)
        .normalize();
    }
    if (cinematic) {
      const pan = ease((shot - 25.4) / 0.95);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      cameraAim.addScaledVector(
        right,
        -2.05 * (1 - pan) * ease((shot - 24.2) / 0.8),
      );
    }
    if (cinematic && shot >= 25.05 && shot <= 27.3) {
      // Frames 760–785: the camera carries the same physical column from the
      // right into the selected position while the neighboring crests subside.
      const pan = ease((shot - 25.4) / 1.05);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const pixelScale = 1080 / openingSpan(span);
      const anchorAim = this.model.position
        .clone()
        // 卡角锚点随补偿态插值：detail=0 墙态=横版卡左上 (-2.5,3.7)，detail=1=竖版左上 (-2.0,5.0)。
        .add(new THREE.Vector3(-CARD_HALF_W * wallS, CARD_H * wallY, 0));
      anchorAim.addScaledVector(
        right,
        -(THREE.MathUtils.lerp(840, 518, pan) - 960) * openingAspect / pixelScale,
      );
      anchorAim.addScaledVector(
        up,
        -(540 - THREE.MathUtils.lerp(340, 288, pan)) / pixelScale,
      );
      cameraAim.lerp(anchorAim, ease((shot - 25.05) / 0.35));
    }
    if (cinematic && shot > 27.3) {
      const close = ease((shot - 27.3) / 6.7);
      const extractionCamera = ease((shot - 27.3) / 1.25);
      const screenX = THREE.MathUtils.lerp(
        518 - 98 * extractionCamera,
        618,
        close,
      );
      const screenY = THREE.MathUtils.lerp(
        296 + 34 * extractionCamera,
        287,
        close,
      );
      const pixelScale = 1080 / openingSpan(THREE.MathUtils.lerp(span, 5.9 * CARD_GROWTH, detail));
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const anchorAim = this.model.position
        .clone()
        // 卡角锚点随补偿态插值：detail=0 墙态=横版卡左上 (-2.5,3.7)，detail=1=竖版左上 (-2.0,5.0)。
        .add(new THREE.Vector3(-CARD_HALF_W * wallS, CARD_H * wallY, 0));
      anchorAim.addScaledVector(right, -(screenX - 960) * openingAspect / pixelScale);
      anchorAim.addScaledVector(up, -(540 - screenY) / pixelScale);
      cameraAim.lerp(anchorAim, ease((shot - 27.3) / 0.5));
    }
    const measureWidth = this.container.clientWidth;
    const measureHeight = this.container.clientHeight;
    const measured = archiveFraming(measureWidth, measureHeight, span, detail,
      this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact");
    const measuredUsable =
      measureWidth > 0 && measureHeight > 0 &&
      Number.isFinite(measured.span) && measured.span > 0;
    const framing = measuredUsable ? measured : this.framing;
    if (!framing) return;                       // 尚无一次可信测量 → 本帧不动相机
    if (measuredUsable) this.framing = framing;
    if (!cinematic) {
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const width = measureWidth, height = measureHeight;
      const pixelScale = height / framing.span;
      const scaleUsable = pixelScale > 0 && Number.isFinite(pixelScale);
      if (scaleUsable) {
      if (framing.portrait) {
        // Keep the preview camera independent of the live lift, wave and rail.
        // Following model.position here would visually cancel those motions.
        const previewAim = new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * height / pixelScale);
        cameraAim.copy(previewAim);
      }
      // 详情取景锚在卡片视觉中线：detail=1 时竖版半高 CARD_H/2=2.5，
      // 墙态仍为横版视觉半高 1.85 → 随 detail 线性递进，避免中途跳变。
      const detailAim = this.model.position
        .clone()
        .add(new THREE.Vector3(0, 1.85 + (CARD_H / 2 - 1.85) * detail, 0));
      detailAim.addScaledVector(right, (0.5 - framing.detailX) * width / pixelScale);
      detailAim.addScaledVector(up, (framing.detailY - 0.5) * height / pixelScale);
      cameraAim.lerp(detailAim, detail);
      }
    }
    const cameraPosition = cameraAim
      .clone()
      .addScaledVector(viewDirection, distance);
    if (!cinematic && !this.reduced && !this.uiOnlyParallax) {
      cameraPosition.x += this.pointer.x * 0.12;
      cameraPosition.y -= this.pointer.y * 0.12;
    }
    const cameraBlend = cinematic ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(cameraPosition, cameraBlend);
    this.cameraAim.lerp(cameraAim, cameraBlend);
    this.camera.lookAt(this.cameraAim);
    this.camera.fov = THREE.MathUtils.lerp(
      this.camera.fov,
      THREE.MathUtils.radToDeg(
        2 * Math.atan((cinematic ? openingSpan(THREE.MathUtils.lerp(span, 5.9 * CARD_GROWTH, detail)) : framing.span) / (2 * distance)),
      ),
      cameraBlend,
    );
    const fog = this.scene.fog as THREE.Fog;
    // The camera position is damped after its target distance changes. Anchor
    // fog to the rendered camera, or entry puts the array behind the far plane
    // until the camera catches up (a brief white wash that exit never showed).
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    const fogTheme = this.themeAmount;
    // 详情态（非原片对照）：雾窗近端推到卡片之后（rd+3，卡半高1.85+余量），
    // 远端保持 rd+12 不变。旧窗 near=rd-1 把卡片本身罩进雾带（底缘约 22% 雾化，
    // 文字与边线被洗淡=用户报的「蒙一层」）；稳定详情态阵列已整批剔除，这层雾
    // 只剩洗卡片一个作用。推后卡片全程无雾；过渡期卡后墙卡仍在 rd+3..12 带内
    // 正常淡出。原片对照保持 rd-1 不变——那里后方阵列可见，雾负责隔离墙与卡。
    const fogDetailNear = cinematic ? -1 : 3;
    fog.near = renderedDistance + THREE.MathUtils.lerp(5 - 4 * fogTheme, fogDetailNear, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(25 - 9 * fogTheme, 12, detail);

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // Build and compact the instance set only after the actual damped camera
    // is final for this frame. Picking uses the same packed index-to-cell map.
    const fixed = (Boolean(cinematic) || !this.looping) && !responsiveOpening;
    this.cells = fixed ? Array.from({ length: 160 }, (_, i) => poolCell(i))
      : this.visibility.update(this.camera, fog.far, trackX, entryZ + this.rail.value, this.extraCoverage);
    const hidden = new Set(this.outgoing.map(o => cellKey(o.cell)));
    hidden.add(cellKey(this.selectedCell));
    this.drawnCells = [];
    this.relayPoints.clear();
    // 上传器惰性兜底：容量未扩容时它们由构造期的实例创建路径留下，这里补一次。
    this.matrixUpdates ??= new InstanceUpdates(this.instances[0].instanceMatrix);
    if (this.themeAttribute) this.themeUpdates ??= new InstanceUpdates(this.themeAttribute);
    if (this.printOffset) this.printUpdates ??= new InstanceUpdates(this.printOffset);
    if (this.printInk) this.inkUpdates ??= new InstanceUpdates(this.printInk);
    // 先收集本帧要提交的格子（含世界坐标与视空间深度），再决定提交顺序。
    // 深度取相机 matrixWorldInverse 的第三行（视空间 z）；相机朝 -z，
    // 所以视空间 z 越大越近 → 降序排列即「由近及远」。
    const pending: { cell: ArchiveCell; x: number; y: number; z: number; depth: number }[] = [];
    const view = this.camera.matrixWorldInverse.elements;
    for (const cell of this.cells) {
      const { row, lane } = cell;
      if (hidden.has(cellKey(cell))) continue;
      const x = (lane - 2) * COLUMN_SPACING - trackX;
      const y = -4.6 + field(row, lane) + hoverLift(cell) - this.presentationDrop(cell);
      const z = (row - 15.5) * ROW_SPACING + entryZ + this.rail.value;
      if (!fixed && !this.visibility.intersects(x, y, z)) continue;
      pending.push({ cell, x, y, z, depth: view[2] * x + view[6] * y + view[10] * z + view[14] });
    }
    // 近→远提交（nearToFarDraw）。只改「写到第几个实例槽」的先后，不改任何数值：
    // 各部件都是不透明体（transmission 材质 transparent=false，走深度测试而非混合），
    // 深度测试保证每像素的最终归属与顺序无关，故像素输出逐位相同；
    // 收益是被近处卡片遮住的像素在 early-Z 阶段就被剔除，不再进入片元着色。
    // 原片对照（fixed）保持池序不变：那是逐帧校准路径，不做任何无关改动。
    if (this.nearToFarDraw && !fixed) pending.sort((a, b) => b.depth - a.depth);
    for (const { cell, x, y, z } of pending) {
      const { row, lane } = cell;
      const i = this.drawnCells.length;
      this.ensureInstanceCapacity(i + 1);
      this.drawnCells.push(cell);
      this.themeUpdates?.scalar(i, this.theme.sample(cell, time));
      // 内容面：把该格对应笔记在图集中的那一格原点（UV 空间，左下为原点）写给实例。
      // 图集第 r 行在纹理里是「从上往下」数，而 UV 的 v 轴向上，故行要翻转。
      if (this.printOffset) {
        const idx = fileAtCell(cell) ?? 0;
        const col = idx % PRINT_ATLAS_COLS;
        const rowFromTop = Math.floor(idx / PRINT_ATLAS_COLS);
        this.printUpdates?.set(i * 2, [
          col / PRINT_ATLAS_COLS,
          1 - (rowFromTop + 1) / this.printAtlasRows,
        ]);
        // 短列重复副本墨色淡出（方案 2）：距本列主副本（选中行所在周期）越远越淡。
        // 原片对照路径（fixed）不淡出——那是逐帧校准，保持池语义。
        this.inkUpdates?.scalar(
          i,
          fixed ? 1 : inkForRank(duplicateRank(lane, row, this.selectedCell.row)),
        );
      }
      const slope = field(row + .5, lane) - field(row - .5, lane);
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(slope * .024 * (1 - detail), 0, 0);
      // B 路线：竖版资产×反向补偿=横版墙面观感。随 detail 连续插值，
      // detail=1 时恢复原生竖版（1,1,1）；幂曲线与 4.5 阻尼抽取近似同步。
      const wallS = 1 - (1 - WALL_SX) * (1 - detail) ** 3;
      const wallY = 1 - (1 - WALL_SY) * (1 - detail) ** 3;
      this.dummy.scale.set(wallS, wallY, 1);
      this.dummy.updateMatrix();
      // 中继点世界视觉高度沿用横版 3.5（墙态补偿后不变）⇒ 局部坐标反除 WALL_SY。
      if (play.enabled) this.relayPoints.set(cellKey(cell), { cell: { ...cell }, point: new THREE.Vector3(0, 3.5 / WALL_SY, 0).applyMatrix4(this.dummy.matrix) });
      // 五个部件共用同一份缓冲 → 每格只写一次
      this.matrixUpdates.set(i * 16, this.dummy.matrix.elements);
    }
    const countChanged = this.instances[0].count !== this.drawnCells.length;
    const matricesChanged = this.matrixUpdates.commit();
    for (const inst of this.instances) inst.count = this.drawnCells.length;
    // Picking uses only the first instanced surface. The other batches disable
    // renderer culling and do not need an O(n) bound recomputation each frame.
    if (matricesChanged || countChanged || !this.instances[0].boundingSphere) this.instances[0].computeBoundingSphere();
    this.themeUpdates?.commit();
    this.printUpdates?.commit();
    this.inkUpdates?.commit();
    let neighborTop = -Infinity;
    const lane = selectedLane,
      row = selectedRow;
    for (let r = row - 5; r <= row + 5; r++) {
      if (r !== row)
        neighborTop = Math.max(neighborTop, -4.6 + field(r, lane) + 3.76);
    }
    for (const o of this.outgoing) {
      if (o.cell.lane === lane && Math.abs(o.cell.row - row) <= 5) {
        neighborTop = Math.max(neighborTop, o.group.position.y + 3.76);
      }
    }
    this.clearance = this.model.position.y - neighborTop;
    this.canInspect =
      !cinematic &&
      Boolean(this.targetDetail) &&
      detail > 0.9 &&
      this.pulseGain < 0.01 &&
      this.clearance > 0.3;
    this.container.dataset.inspection =
      this.returnY !== null
        ? "aligning"
        : this.canInspect
          ? "ready"
          : this.targetDetail
            ? "lifting"
            : "preview";
    // 焦点对准卡面中心：竖版局部半高 CARD_H/2=2.5（旧横版校准值 2 会偏下 0.5，
    // 开景深时卡面上下缘脱焦发糊——用户 2026-10-16「似乎又开始变得模糊了」）。
    const focalPoint = this.model.position
      .clone()
      .add(new THREE.Vector3(0, CARD_H / 2, 0))
      .applyMatrix4(this.camera.matrixWorldInverse);
    const bokehUniforms = this.bokeh.uniforms as Record<
      string,
      { value: number }
    >;
    bokehUniforms.focus.value = -focalPoint.z;
    bokehUniforms.aperture.value =
      (THREE.MathUtils.lerp(0.0003, 0.0008, detail) *
        this.quality.depthOfField) /
      100;
    this.renderer.info.reset();
    // 折射缓冲分辨率（three transmissionResolutionScale）：磨砂卡的折射每帧把场景
    // 重渲染进缓冲，是逐帧最大的隐藏开销。墙态磨砂粗粝（roughness 0.21~0.28）会
    // 遮住缓冲分辨率，减半后观感不变、该通道像素工作量约降 4×（2026-10-16 用户
    // 「希望整体动画更流畅，不是削减画面效果」）；详情态盖板近清透（roughness
    // 0.02）且透过盖板看内构，缓冲必须全分辨率，否则内构重新发糊。
    this.renderer.transmissionResolutionScale =
      this.mode === "detail" ? 1 : 0.5;
    // 模拟结束后统一更新一次世界矩阵（scene.matrixWorldAutoUpdate = false）；
    // 阴影图也只在本帧真正绘制时重新生成（shadowMap.autoUpdate = false）。
    this.scene.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
    if (this.superPerformance) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
  projectCard(x: number, y: number) {
    this.model.updateMatrixWorld(true);
    const p = this.model
      .localToWorld(new THREE.Vector3(x, y, CARD_FACE_Z))
      .project(this.camera);
    return [(p.x + 1) * this.container.clientWidth / 2, (1 - p.y) * this.container.clientHeight / 2];
  }
  get decryptionFrame() { return this.decryption.frame; }
  finishDecryption() { this.decryption.finish(); }
  /** 诊断只读：当前墙面淡出系数（1=正常，0.07=详情态隐约可见）。 */
  get arrayFadeAmount() { return arrayFade.value; }
  get detailVisibility() {
    return ease((this.detail - 0.25) / 0.55);
  }
  getStats() {
    this.model.updateMatrixWorld(true);
    const project = (x: number, y: number, z: number) => {
      const p = this.model
        .localToWorld(new THREE.Vector3(x, y, z))
        .project(this.camera);
      return [Math.round((p.x + 1) * this.container.clientWidth / 2), Math.round((1 - p.y) * this.container.clientHeight / 2)];
    };
    return {
      decryption: { ...this.decryption.frame, clarity: this.decryption.clarity },
      topLeft: project(-CARD_HALF_W, CARD_H, 0),
      topRight: project(CARD_HALF_W, CARD_H, 0),
      // 竖版标签贴花平面 0.79×0.56 @ (−1.085, 4.11) → 上/下左角
      labelTopLeft: project(-1.7, 4.39, CARD_FACE_Z),
      labelBottomLeft: project(-1.7, 3.83, CARD_FACE_Z),
      modelPosition: this.model.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraPosition: this.camera.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      fieldOfView: this.camera.fov,
      loaded: this.loaded,
      drawCalls: this.renderer.info.render.calls,
      superPerformance: this.superPerformance,
      presentation: this.presence,
      triangles: this.renderer.info.render.triangles,
      archiveCount: this.drawnCells.length,
      archiveCandidates: this.cells.length,
      archiveCulled: this.cells.length - this.drawnCells.length,
      archiveCapacity: this.instanceCapacity,
      archiveCoverage: this.extraCoverage ? "extra" : "standard",
      returningFiles: this.outgoing.length,
      selectionPhase: this.pendingPulse
        ? "lifting"
        : this.pulses.length
          ? "wave"
          : "settled",
      pendingPulse: this.pendingPulse ? { ...this.pendingPulse } : null,
      pulses: this.pulses.map((pulse) => ({ ...pulse })),
      referenceTime: Math.round((this.scanTime + 5) * 100) / 100,
      selectedSlot: this.selectedSlot,
      selectedLane: Math.floor(this.selectedSlot / 32),
      selectedCell: { ...this.selectedCell },
      hoverCell: this.hoverCell ? { ...this.hoverCell } : null,
      hoverLifts: Object.fromEntries(this.hoverLifts),
      dragTrack: this.dragTrack ? { ...this.dragTrack } : null,
      archiveMomentum: this.archiveMomentum ? {
        phase: this.archiveMomentum.motion.phase,
        value: this.archiveMomentum.motion.value,
        velocity: this.archiveMomentum.motion.velocity,
      } : null,
      holdingArchive: this.holdingArchive,
      dragProjection: this.dragProjection(),
      dragMapping: this.archiveDrag.active ? "free" : null,
      coordinateOrigin: { ...this.coordinateOrigin },
      poolBounds: {
        minLane: Math.min(...this.cells.map((c) => c.lane)),
        maxLane: Math.max(...this.cells.map((c) => c.lane)),
        minRow: Math.min(...this.cells.map((c) => c.row)),
        maxRow: Math.max(...this.cells.map((c) => c.row)),
      },
      laneFocus: this.laneFocus.value,
      columnCamera: this.columnCamera.value,
      rotation: this.rotation,
      clearance: this.clearance,
      canInspect: this.canInspect,
      returnPhase: this.returnY !== null ? "aligning" : "lowering",
      extraction: Math.round(this.lift.value * 1000) / 1000,
      appearance: Math.round(ease(this.lift.value / 0.4) * 1000) / 1000,
      cameraDetail: Math.round(this.detail * 1000) / 1000,
      idleGain: this.idleGain,
      flatten: this.flatMix,
      spectrumActivity: this.playfield.bands.activity,
      selectedIndexDim: this.model.children.find(child => child.userData.surface === "Index_Inlay")?.userData.subduedIndex?.value,
      returningIndexDims: this.outgoing.map(o => ({ cell: o.cell, dim: o.group.children.find(child => child.userData.surface === "Index_Inlay")?.userData.subduedIndex?.value })),
      cameraDistance: this.camera.position.distanceTo(this.cameraAim),
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      fogNear: (this.scene.fog as THREE.Fog).near,
      fogFar: (this.scene.fog as THREE.Fog).far,
      returningAppearance: this.outgoing.map((o) => ({
        slot: o.slot,
        cell: { ...o.cell },
        lift: o.lift.value,
        quality: ease(o.lift.value / 0.4),
        rotation: o.group.rotation.y,
        worldY: o.group.position.y,
        phase: o.returnY !== null ? "aligning" : "lowering",
      })),
      rail: Math.round(this.rail.value * 1000) / 1000,
    };
  }
}
