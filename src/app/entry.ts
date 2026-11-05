/**
 * Rhine Archive Terminal — Obsidian plugin entry (adapted from RhineLabUI main.ts).
 * Runs inside a srcdoc iframe created by the host plugin:
 *  - data comes from window.RHINE_DATA (vault scan result)
 *  - assets resolve through window.RHINE_BASE_URL
 *  - "open in Obsidian" posts { type: "rhine-open", path } to the parent
 *  - the host can pause/resume the render loop via postMessage
 */
import { createRollingClock } from "./rolling-clock";
import { InspectionOverlay } from "./inspection-overlay";
import { DocumentDecryption } from "./document-decryption";
import "./document-decryption.css";
import "./decryption.css";
declare const __RHINE_FONT_NAME__: string;
declare const __RHINE_FONT_LICENSE__: string;

import { escapeHtml } from "./html";
import { normalizeQuality, qualityPresets, saverQualityFor, type QualityPreset, type RenderQuality } from "./render-quality";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./responsive.css";
import { viewportLayout, openingLayout } from "./viewport-layout";
import { ArchiveScene } from "./scene";
import { ModelViewer } from "./model-viewer";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { BootSequence } from "./boot";
import { loadBootWebfonts } from "./boot-lettering";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import {
  records,
  categories,
  archiveColumns,
  columnFiles,
  fileLocation,
  setData,
  applyDirectory,
  type ArchiveRecord,
} from "./data";
import { TerminalAudio } from "./audio";
import { audioSettingsMarkup } from "./audio-settings";
import { StartupGate } from "./startup";
import "./startup.css";
import { gateRequired, runGateFlow } from "./gate-card";
import { createRollingNumber, createRollingText } from "@kitlangton/rolling-number";
import { logo, brandHeading, galleryName } from "./brand";
import { paintTheme, themeSettingsMarkup } from "./theme-ui";
import { superPerformanceQuality } from "./wallpaper-quality";
import "./plugin-extras.css";

// 开机时间轴整体加速：原版完整流程约 35 秒，插件场景压缩到 ~16 秒。
const BOOT_SCALE = 0.45;

// 当天再次进入时的快放（2026-10-18 用户裁定：「还是可以播放进场动画的，只不过可以加快一点」）：
// 首次进入按原速完整播；当天已播过则播加速版，并在阵列展开后收尾进墙（不自动选档、不进详情）。
const BOOT_REPLAY_RATE = 1.8; // 相对当前节奏的倍数（1.8 → 约 5s，原速约 13s）
// 收尾胶片时间：阵列已展开、提示线走完，但**在卡片抬升（26）与镜头推进（27.3）之前**收住，
// 这样退场时阵列保持静止的整体视角，不会停在半抬升/半推进的中间态。
const BOOT_REPLAY_CUT = 17.6;
// bootStart 的既有约定隐含起点（= 1.76 / BOOT_SCALE²）。加速时只压缩「走过的时长」，起点保持不变。
const BOOT_START_T = 1.76 / BOOT_SCALE / BOOT_SCALE;

/** 拼资源绝对地址（与 iframe 的 <base href> 同源）。 */
function assetUrl(relative: string) {
  const base = window.RHINE_BASE_URL ?? "";
  return `${base}${relative}`;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

// 图形上下文丢失（显存回收 / 驱动重置）→ 尝试恢复，失败则明确提示，避免"画面莫名消失"。
window.addEventListener(
  "webglcontextlost",
  (event) => {
    event.preventDefault();
    notify("显示资源被系统回收，正在尝试恢复…");
    const restored = scene?.restoreGraphics() ?? false;
    window.setTimeout(() => {
      if (!scene || scene.graphicsLost) {
        notify("图形上下文未能自动恢复：请按 F5 或重开此视图");
      } else if (restored) {
        window.setTimeout(() => notify("显示已恢复"), 300);
      }
    }, 1600);
  },
  true,
);
window.addEventListener(
  "webglcontextrestored",
  () => {
    notify("显示已恢复");
  },
  true,
);

// 任何未捕获错误自动上报宿主（Obsidian Notice），便于真机排障。
let errorReportCount = 0;
function reportToHost(message: string) {
  if (errorReportCount++ > 5) return; // 防刷屏
  try { postToHost({ type: "rhine-error", message: message.slice(0, 400) }); } catch {}
}
window.addEventListener("error", (e) => {
  reportToHost(`${e.message} @ ${String(e.filename).split("/").pop()}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ""}` : String(e.reason);
  reportToHost(`REJECTION: ${reason}`.slice(0, 400));
});

function postToHost(message: Record<string, unknown>) {
  try {
    window.parent.postMessage({ source: "rhine-terminal", ...message }, "*");
  } catch {
    /* host bridge unavailable */
  }
}

$("#stage").innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="scene-atmosphere archive-atmosphere"></div>
  <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" stroke="#fff" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg></div>
  <header class="brand">${brandHeading}</header>
  <nav class="system-nav" aria-label="系统导航">
    <button data-action="search"><span class="nav-glyph">⌕</span> ARCHIVE INDEX <span class="key">/</span></button>
    <button class="settings-button" data-action="settings" aria-label="系统设置" title="系统设置"><span class="settings-glyph" aria-hidden="true">◷</span><span class="settings-label">设置</span></button>
  </nav>
  <button id="skip" class="skip" data-action="skip">ENTER SYSTEM <span>↗</span></button>
  <section id="boot" class="boot" aria-label="系统启动">
    <div class="access-text">ACCESS</div>
    <div class="boot-logo">${logo}</div>
    <div class="auth-status"><span>▪</span> <span id="auth-message"></span><i></i></div>
    <div class="scan"><svg viewBox="0 0 1920 1080" aria-hidden="true"><g fill="none" stroke="#080a08" stroke-width="2" stroke-linecap="round"><path/><path stroke="#fff"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>PERMISSION AUTHORIZED</span></div>
    <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>${galleryName}</strong><strong class="welcome-highlight" aria-hidden="true">${galleryName}</strong></div><div class="welcome-database">INTERNAL DATABASE</div><div class="welcome-logo">${logo}</div></div>
  </section>
  <svg id="inspection-marks" viewBox="0 0 1920 1080" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
  <div id="inspection-text" aria-hidden="true">CONFIDENTIALITY:<strong>GENERAL BUSINESS USE</strong></div>
  <section id="archive-ui" class="archive-ui" aria-label="档案选择">
    <div id="folder-banner" class="folder-banner" aria-live="polite"><nav id="folder-crumbs" class="fb-crumbs" aria-label="目录层级"></nav><button id="folder-switch" data-action="folder-menu">切换目录 <span>▾</span></button><div id="folder-menu" hidden></div></div>
    <div class="archive-callout"><div class="eyebrow">INTERNAL DATABASE <span>／</span> <span id="archive-category">机构档案</span></div><button class="file-title" data-action="open"><span id="selected-id">X-<span id="selected-code">001</span></span><span id="selected-title">莱茵生命</span><span class="file-open">↗</span></button><div class="callout-rule"><i></i></div><div class="file-summary"><span id="selected-clearance">BUSINESS AREA</span><span id="selected-column">机构档案</span></div><button class="read-file" data-action="open">ACCESS FILE <span>→</span></button></div>
    <div id="hover-label" class="hover-label">X-<span id="hover-code">001</span> ／ <span id="hover-title"></span> ／ <span id="hover-folder"></span></div>
    <div class="archive-counter"><span class="tiny-label">ARCHIVE / SELECT</span><div><span id="selected-number">01</span><i>/</i><span class="count-total">12</span></div></div>
    <div class="archive-navigation"><button data-action="prev" aria-label="上一个档案">↑</button><div id="file-ticks" class="file-ticks"></div><button data-action="next" aria-label="下一个档案">↓</button></div>
    <div class="column-navigation"><button data-action="column-prev" aria-label="上一列">←</button><div><span id="column-number">COLUMN <span id="column-index">03</span> / <span id="column-total">05</span></span><strong id="column-name">机构档案</strong></div><button data-action="column-next" aria-label="下一列">→</button></div>
    <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 切换列 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 前后档案 <span>／</span> <kbd>ENTER</kbd> 读取</div>
  </section>
  <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
    <button class="back-button" data-action="back">← <span>ARCHIVE OVERVIEW</span><small>ESC</small></button>
    <div class="object-caption"><span id="object-id">NO.001</span><div>INTERNAL DATABASE</div><small>DRAG TO INSPECT <span>↔</span></small></div>
    <article id="detail-content" class="detail-content"></article>
  </section>
  <div class="powered">POWERED BY <b>${galleryName}</b><i></i></div>
  <footer class="system-footer"><span><i class="status-light"></i> SESSION AUTHORIZED</span><span>CL <i>／</i> <span id="clock">00:00:00</span></span><button data-action="replay" title="重播启动流程">REINITIALIZE ↗</button></footer>
  <div id="modal-root"></div><div id="display-status" class="display-status" role="status" hidden></div><div id="toast" class="toast" role="status"></div>
  <div id="loading" class="loading"><div class="loading-mark">${logo}</div><span>CONNECTING TO INTERNAL DATABASE</span><i></i></div>
`;

$("#boot-background").insertAdjacentHTML("beforeend", '<div class="boot-white"></div>');
$("#viewport").insertAdjacentHTML("beforeend", '<button class="mobile-entry" data-action="skip">进入档案 <span>→</span></button>');
const bootSequence = new BootSequence($("#stage"));

type Mode = "boot" | "archive" | "detail";
let mode: Mode = "boot",
  selected = 0,
  bootStart = 0,
  bootRate = 1,
  lastStep = "",
  ready = false;
let modal: "search" | "saved" | "settings" | null = null,
  searchQuery = "",
  filter = "全部档案";
let activeTab = "overview";
let toastTimer: ReturnType<typeof setTimeout>;
let previousFocus: HTMLElement | null = null;
const detailTransition = new SurfaceTransition($("#detail-ui"), undefined, 180, 180);
const tabTransition = new ContentTransition();
let modalTransition: SurfaceTransition | undefined;
let modalClosing = false;
let modalSiblings: { node: HTMLElement; inert: boolean }[] = [];
let pendingDetailFocus = false;
let bookmarkFeedback: Animation | undefined;

function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
/** 开机动画每天只播一次：记录最近一次播放的本地日期（YYYY-MM-DD）。
 *  当天再次打开视图直接进档案墙；跨天首开重新播放。 */
const BOOT_DAY_KEY = "rhine-terminal-boot-day";
const todayStamp = () => new Date().toLocaleDateString("sv-SE");
function bootPlayedToday() {
  return readLocal<string>(BOOT_DAY_KEY, "") === todayStamp();
}
function markBootPlayed() {
  try {
    localStorage.setItem(BOOT_DAY_KEY, JSON.stringify(todayStamp()));
  } catch {}
}
const saved = new Set<string>(readLocal<string[]>("rhine-terminal-saved", []));
const storedPrefs = readLocal<Partial<{ sound: boolean; music: boolean; soundVolume: number; musicVolume: number; reduced: boolean; quality: boolean; superPerformance: boolean; rendering: RenderQuality; colorTheme: "light" | "dark"; _v?: string }>>("rhine-terminal-settings", {});
// v1 存档的画质是旧默认（原始档），升级到 v2 时丢弃一次，换用性能档起步。
const prefsUpgraded = storedPrefs._v === "v2";
const prefs = {
  sound: true,
  music: storedPrefs.sound ?? true,
  soundVolume: .55,
  musicVolume: .5,
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  quality: true,
  superPerformance: false,
  ...storedPrefs,
  // 插件默认从性能档起步：保住完整视觉风格，砍掉 SSAO/景深/SMAA 等重开销。
  rendering: normalizeQuality(prefsUpgraded ? storedPrefs.rendering ?? { ...qualityPresets.performance } : { ...qualityPresets.performance }, storedPrefs.quality !== false),
  colorTheme: storedPrefs.colorTheme === "dark" ? "dark" : "light",
};
paintTheme(prefs.colorTheme === "dark" ? 1 : 0);

const rollingMotion = {
  duration: 460,
  motionBlur: true,
  animated: !prefs.reduced,
};
const updateFooterClock = createRollingClock($("#clock"));
const numberOptions = {
  ...rollingMotion,
  locales: "en-US",
  format: { minimumIntegerDigits: 2, useGrouping: false },
};
const fileCounter = createRollingNumber($("#selected-number"), {
  ...numberOptions,
  value: 1,
});
const columnCounter = createRollingNumber($("#column-index"), {
  ...numberOptions,
  value: 3,
});
const codeOptions = {
  ...numberOptions,
  format: { minimumIntegerDigits: 3, useGrouping: false },
  value: 1,
};
const textOptions = {
  ...rollingMotion,
  transition: "direct" as const,
  stagger: "none" as const,
};
  // 主标题=文件名（用户 2026-10-15 裁定「换过来」：文件名是主标识，X-NNN 编号降为前缀小字）
const selectionTitle = createRollingText($("#selected-title"), {
  ...textOptions,
  text: $("#selected-title").textContent ?? "",
});
const columnTitle = createRollingText($("#column-name"), {
  ...textOptions,
  text: $("#column-name").textContent ?? "",
});
const hoverTitle = createRollingText($("#hover-title"), { ...textOptions, text: "" });
const categoryTitle = createRollingText($("#archive-category"), {
  ...textOptions,
  text: $("#archive-category").textContent ?? "",
});
const clearanceTitle = createRollingText($("#selected-clearance"), {
  ...textOptions,
  text: $("#selected-clearance").textContent ?? "",
});
const rollingTitles = [selectionTitle, columnTitle, hoverTitle, categoryTitle, clearanceTitle];
const selectedCode = createRollingNumber($("#selected-code"), codeOptions);
const hoverCode = createRollingNumber($("#hover-code"), codeOptions);

const audio = new TerminalAudio();
function configureAudio() { audio.configure({ ...prefs }); }
configureAudio();

let started = false;
const loading = $("#loading");
$("#viewport").append(loading);
$("#stage").inert = true;
$(".mobile-entry").inert = true;

/**
 * 进场阶段的可见诊断（2026-10-18 排障「一直加载中」）：
 * 未捕获错误、载入超时、数据异常都写进加载屏底部并回报宿主，
 * 任何一处卡住都能从截图上直接读出阶段与原因，不再静默停在「正在准备终端…」。
 */
function bootLine(): HTMLElement {
  let line = loading.querySelector<HTMLElement>(".boot-warn");
  if (!line) {
    line = document.createElement("p");
    line.className = "boot-warn";
    loading.appendChild(line);
  }
  return line;
}
function setEntryStage(text: string) {
  const status = loading.querySelector<HTMLElement>(".entry-status");
  if (status) status.textContent = text;
  else bootLine().textContent = text;
}
function reportEntryError(label: string, detail: unknown) {
  const message = detail instanceof Error ? detail.message : String(detail ?? "");
  bootLine().textContent = `${label}：${message}`.slice(0, 180);
  console.error(label, detail);
  postToHost({ type: "rhine-error", message: `${label}：${message}`.slice(0, 180) });
}
window.addEventListener("error", event => reportEntryError("脚本错误", event.message));
window.addEventListener("unhandledrejection", event => reportEntryError("异步错误", event.reason));
/** 载入不得无限期挂起：超时或失败都继续（降级进入），原因写到加载屏。 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise<T | undefined>(resolve => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    // 计时器必须随成功一起清掉：否则慢机器上资源已经载入完成，30s 后仍会
    // 补写一行「超时」假警报（真机与 SwiftShader 无头环境都踩到过）。
    const timer = window.setTimeout(() => {
      reportEntryError(`${label} 超时`, "已降级继续");
      finish(undefined);
    }, ms);
    work.then(
      value => finish(value),
      error => {
        reportEntryError(`${label} 失败`, error);
        finish(undefined);
      },
    );
  });
}
const entry = prefs.sound || prefs.music ? new StartupGate({
  root: loading,
  unlock: () => audio.unlock(),
  cancel: () => audio.cancelEntry(),
  // 闸门模式：声音解锁成功后才滑出登录卡（用户指令：点击进入→左移→密码→回位播原动画）；
  // 声音失败走无声分支同样进闸门，不掉出流程。
  start: silent => {
    if (gateRequired) void openGate(silent);
    else completeStartup(silent);
  },
}) : undefined;
if (entry) {
  audio.holdForEntry();
  if (prefs.music) {
    void audio.prepareMusic().catch(() => { /* Entry offers retry. */ });
    // 进入终端画面即起播：背景音乐应在视图打开时就响，而不是等点进登录卡。
    // 宿主允许自动播放时会立即生效；若仍被浏览器拦下，登录卡的 unlock() 兜底。
    void audio.unlock().catch(() => { /* Gate click retries. */ });
  }
}

let scene: ArchiveScene | undefined;
let viewer: ModelViewer | undefined;
const accessLog: { id: string; time: string }[] = [];
const columnMemory: number[] = [];
function rebuildColumnMemory() {
  columnMemory.length = 0;
  for (const _ of archiveColumns) columnMemory.push(NaN);
  archiveColumns.forEach((_, lane) => (columnMemory[lane] = columnFiles(lane)[0]));
}

function recordAccess() {
  accessLog.unshift({
    id: records[selected].id,
    time: new Date().toLocaleTimeString("en-GB"),
  });
}
function saveAudioPrefs() {
  try {
    localStorage.setItem("rhine-terminal-settings", JSON.stringify({ ...prefs, _v: "v2" }));
  } catch {}
  configureAudio();
}
/** 自动降级档位：0 = 用户设定，1 = 省电（**保留阴影与磨砂质感**）。自动档最高只降到 1；
 *  2 = 性能优先（无阴影白盒档）仅手动开关可达（用户 2026-10-15 裁定：不许自动变成那样）。
 *  只在本会话内生效、不写盘——否则一次偶发卡顿会把画质永久锁死在最低档。 */
let autoTier = 0;
/** 手动改画质后的观察窗口截止时刻（毫秒）。窗口内不自动降档，让用户选的画质先展示；
 *  窗口过后若帧率确实不行，再从 0 重新逐级降（流畅底线不变）。 */
let qualityHoldUntil = 0;
const QUALITY_HOLD_MS = 15_000;
/** 用户在设置里主动改了画质 = 显式意图，优先级高于自动降级：
 *  清自动档、暂停降档计时，并关闭旧版可能残留的「性能优先」持久化开关。 */
function noteManualQualityChange() {
  autoTier = 0;
  lowFpsSeconds = 0;
  highFpsSeconds = 0;
  qualityHoldUntil = performance.now() + QUALITY_HOLD_MS;
  if (prefs.superPerformance) {
    prefs.superPerformance = false;
    const toggle = document.querySelector<HTMLInputElement>('input[data-pref="superPerformance"]');
    if (toggle) toggle.checked = false;
    notify("已关闭「性能优先」以应用你选择的画质");
  }
}
/** 性能优先档（无阴影白盒）仅手动开关可达；自动档封顶 1，不再触发它。 */
function superPerformanceEnabled() {
  return prefs.superPerformance;
}
/** 详情态提清（2026-10-15 用户裁定：详情态阵列已裁半、性能有富余，画面应该好一点）。
 *  进入详情默认全清（1080p）；帧率保险丝先退半清档（1536×864，≈1.5× 帧率），
 *  仍不达标才完全收回——低配机器也能留住一档清晰度（流畅红线：半清档实测
 *  帧率不低于常规档，降档不亏流畅）。档位 0/1/2，回阵列恢复 0。 */
let detailBoostLevel = 0;
const DETAIL_BOOST_FULL_FPS = 26;   // 全清档低于此 → 退半清
const DETAIL_BOOST_MID_FPS = 24;    // 半清档低于此 → 收回常规
const DETAIL_BOOST_RECOVER_FPS = 30; // 半清档高于此持续 12 秒 → 回全清
let detailBoostLowSeconds = 0;
let detailBoostHighSeconds = 0;
/** 详情提清的降档阈值与提示按当前有效画质分档。
 *  详情是静态画面（仅卡片缓慢旋转/呼吸），流畅所需帧率远低于阵列动态场景。
 *  125% 屏（物理 1920×1080）上：全清档=原生 1920×1080（清晰）、半清档=1536×864
 *  （1.25× 拉伸=「蒙」）、常规更糊——阶梯每降一档都更糊，降档省帧率的代价正是用户
 *  投诉的糊。性能档用户（pixelRatio≤1 且 scale≤80，含性能预设/性能优先/自动降档）
 *  已主动选择省资源：几乎钉死原生全清（仅帧率真正难看到 <15 才降），且不弹降档提示
 *  ——用户 2026-10-16 反馈「我一直是性能模式，不该有这个提示」。 */
function detailBoostTuned() {
  const q = effectiveRenderQuality();
  return q.pixelRatio <= 1 && q.scale <= 80
    ? { full: 15, mid: 12, recover: 20, silent: true }
    : { full: DETAIL_BOOST_FULL_FPS, mid: DETAIL_BOOST_MID_FPS, recover: DETAIL_BOOST_RECOVER_FPS, silent: false };
}
function setDetailBoostLevel(level: number, reason?: string) {
  const value = Math.max(0, Math.min(2, level));
  if (detailBoostLevel === value) return;
  detailBoostLevel = value;
  detailBoostLowSeconds = 0;
  detailBoostHighSeconds = 0;
  scene?.setDetailBoostLevel(value);
  if (reason) notify(reason);
}
function effectiveRenderQuality(): RenderQuality {
  if (superPerformanceEnabled()) return superPerformanceQuality;
  // 先降到「省电但保玻璃」，只有在仍然不流畅时才切到取消折射的性能优先档。
  return autoTier >= 1 ? saverQualityFor(prefs.rendering) : prefs.rendering;
}
/** 逐级降/回升。降档 4 秒判定，回升要 12 秒且阈值更高（54fps），避免阈值附近来回跳。
 *  自动档封顶 1（保阴影省电档）：用户体感「性能」预设可接受，阈值按真机下调到 30fps；
 *  性能优先（档 2）只能由手动开关进入。
 *  与 detailBoostTuned 同理（2026-10-17 用户：性能预设下「依旧会有这样的显示，且屏幕会闪烁」）：
 *  用户已主动选性能档（pixelRatio≤1 且 scale≤80）时不再参与自动降/升档——v8.9.2 只静音了
 *  提示，setAutoTier→applyPrefs 的画质重分配照旧执行=闪烁根因（探针实证：入场瞬时低谷
 *  8fps 连触 4s 判定，canvas 1536×864→1344×756）；且回升阈值 40fps 在性能档永不可达，
 *  降档后会永久卡在低画质。自动机制必须尊重用户已选档位（2026-10-16 裁定）。
 *  ⚠ 判据用 prefs.rendering（用户主动选择），不能用 effectiveRenderQuality()——
 *  后者含 autoTier，降过档会把阈值自己改掉。 */
function autoTierTuned() {
  const q = prefs.rendering;
  return q.pixelRatio <= 1 && q.scale <= 80
    ? { low: 20, high: 40, silent: true }
    : { low: 30, high: 54, silent: false };
}
function setAutoTier(next: number) {
  const value = Math.max(0, Math.min(1, next));
  if (value === autoTier) return;
  autoTier = value;
  lowFpsSeconds = 0;
  highFpsSeconds = 0;
  applyPrefs();
  if (autoTierTuned().silent) return;
  notify(
    value === 0
      ? "帧率已恢复，画质已回到你的设置"
      : "检测到帧率偏低，已自动降档（保留阴影与磨砂质感）；若仍不流畅可在设置中手动开启性能优先",
  );
}
function savePrefs() {
  saveAudioPrefs();
  applyPrefs();
}
/** 把当前偏好（含自动降级档）真正应用到场景与界面；不写盘。 */
function applyPrefs() {
  if (prefs.reduced) {
    rollingTitles.forEach(title => title.finish());
    detailTransition.finish();
    modalTransition?.finish();
    tabTransition.cancel();
    bookmarkFeedback?.cancel();
  }
  scene?.setReduced(prefs.reduced);
  scene?.setTheme(prefs.colorTheme === "dark", prefs.reduced || !started);
  document.querySelectorAll<HTMLElement>("[data-color-theme]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.colorTheme === prefs.colorTheme)));
  scene?.setSuperPerformance(superPerformanceEnabled());
  viewer?.setSuperPerformance(superPerformanceEnabled());
  scene?.setQuality(effectiveRenderQuality());
  viewer?.setQuality(effectiveRenderQuality());
  syncQualityUI(prefs.rendering);
  fileCounter.update({ animated: !prefs.reduced && mode === "archive" });
  rollingTitles.forEach(title => title.update({ animated: !prefs.reduced && mode === "archive" }));
  columnCounter.update({ animated: !prefs.reduced && mode === "archive" });
  selectedCode.update({ animated: !prefs.reduced && mode === "archive" });
  hoverCode.update({ animated: !prefs.reduced && mode === "archive" });
  $("#stage").classList.toggle("reduce-motion", prefs.reduced);
  updateQualitySummary();
}

let previousLayout = "";

/* —— 品牌块右边界对齐（2026-10-18 用户「排版合理一点视觉对齐」+「要能自适应各种情况」）——
   原片三行右边界天然齐（固定字样 RHINE LAB，宽 269.78 / 269.63 / 270）。本项目把第一行
   换成自适应仓库名后，MEMORY 在此字号下只有 243px，右边界比第二行短 27px —— 仓库名越短越空。
   做法：第一行始终按容器宽（270 设计像素）对齐右缘。
     · 名字偏窄 → 用字距撑开（每缝 gap，上限 maxTrackEm，避免把单字撑成夸张字缝）
     · 名字偏宽 → 缩字号（下限 minScale），保证不溢出容器、右缘仍贴齐
   两个旋钮都按「实测自然宽度」现算，所以任意仓库名、任意视口都自适应。
   注意：本函数必须定义在 fit() 之前——fit() 会回调它，而 const 存在暂时性死区
   （TDZ），定义晚于首次调用会抛 ReferenceError 并中断整个初始化（实测卡在 boot 态）。
   boot 态主动让位并清空 inline：开机逐字母动画用 --boot-phrase-tracking，不能被覆盖。 */
const BRAND_FIT = { maxTrackEm: 0.14, minScale: 0.22 };
function fitBrand(): boolean {
  const stage = $("#stage");
  const brand = document.querySelector<HTMLElement>(".brand");
  const h1 = brand?.querySelector<HTMLElement>("h1");
  if (!stage || !brand || !h1) return true; // 没得量也没得改，视为完成
  if (stage.dataset.mode === "boot") {
    h1.style.fontSize = "";
    h1.style.letterSpacing = "";
    h1.style.removeProperty("--boot-phrase-tracking");
    return true;
  }
  // 有效缩放：#stage 的 transform 之外，.brand 在紧凑/竖屏档还有自己的 scale(.36/.42)。
  // rect.width（渲染像素）÷ offsetWidth（布局像素）= 全部变换的合成比例，两边都要除掉，
  // 才能在设计像素坐标系里比较（实测：portrait 只除 stage 缩放会算错、字距顶到上限）。
  const effScale = (brand.getBoundingClientRect().width / (brand.offsetWidth || 1)) || 1;
  // 量「自然墨迹宽」。档案态可见字是 .boot-phrase（SVG 字形）或回退用的
  // .boot-phrase-label（无网络字体时）；两者都在 h1 内且其一 display:none。
  // ⚠️ 不能按 [hidden] 属性筛：.boot-phrase 隐藏时是 display:none 的绝对定位元素，
  // 属性上仍"未被 hidden"，选中它会量到 0 宽 → natural<8 提前 return，字距不生效。
  // 必须按 computed display + 实际宽度判定。
  const shown = (node: HTMLElement | null) =>
    node && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 1 ? node : null;
  const visible =
    shown(h1.querySelector<HTMLElement>(".boot-phrase")) ??
    shown(h1.querySelector<HTMLElement>(".boot-phrase-label")) ??
    h1;
  const measure = () => {
    const r = document.createRange();
    r.selectNodeContents(visible);
    return r.getBoundingClientRect().width / effScale;
  };
  h1.style.fontSize = "";
  h1.style.letterSpacing = "";
  h1.style.removeProperty("--boot-phrase-tracking");
  const baseSize = parseFloat(getComputedStyle(h1).fontSize) || 50.75;
  const text = (visible.textContent ?? h1.textContent ?? "").replace(/\s+/g, "");
  const characters = [...text].length;
  if (characters < 2) return true;
  const natural = measure();
  if (!natural || natural < 8) return false; // 尚未参与布局（boot 跳过路径），交给重试
  const target = brand.offsetWidth || 270;
  const maxTrack = baseSize * BRAND_FIT.maxTrackEm;
  // 目标：第一行的**排版右缘**落在容器右缘（与二/三行同一基准；DESIGN.md 的原片校准值
  // 269.78 / 269.63 / 270 就是按 Range 排版宽度量的，故这里也用 Range 宽）。
  // letter-spacing 给每个字符后都加空隙（含最后一个），Range 宽 = natural + n*track，
  // 令其 = target → track = (target - natural)/n。
  const apply = (t: number, s: number) => {
    h1.style.fontSize = `${(baseSize * s).toFixed(2)}px`;
    h1.style.letterSpacing = `${t.toFixed(2)}px`;
    h1.style.setProperty("--boot-phrase-tracking", `${t.toFixed(2)}px`);
  };
  const want = (target - natural) / characters;
  if (want >= 0) {
    const t = Math.min(want, maxTrack);
    apply(t, 1);
    if (want > maxTrack) {
      // 极短名：字距撑到上限仍不够，再缩字号补齐
      apply(t, Math.max(BRAND_FIT.minScale, Math.min(1, target / Math.max(measure(), 1))));
    }
  } else {
    // 名字比容器宽：缩字号让右缘贴齐（字距回 0）。下限 0.22≈11px，够容纳 30 字符级
    // 的极端仓库名；常规仓库名（≤20 字符）落在 0.4~0.8 区间，可读性无损。
    apply(0, Math.max(BRAND_FIT.minScale, Math.min(1, target / natural)));
  }
  return true;
}
// 有限次重试：boot 被跳过时 setMode("archive") 在初始化里同步触发，此刻 .brand 可能
// 还没参与布局（量到 0 宽）或字体未 ready；下一帧再量，最多 30 帧（≈0.5s）后放弃，
// 放弃也只是维持原样，不会死循环。
function scheduleBrandFit() {
  let tries = 0;
  const step = () => {
    const done = fitBrand();
    if (done === false && tries++ < 30) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function fit() {
  const stage = $("#stage");
  const viewport = $("#viewport");
  const coarse = matchMedia("(pointer: coarse)").matches;
  const { width, height, scale, kind } = mode === "boot"
    ? openingLayout(viewport.clientWidth, viewport.clientHeight)
    : viewportLayout(viewport.clientWidth, viewport.clientHeight, coarse, false);
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  stage.style.visibility = "visible";
  stage.dataset.layout = kind;
  stage.dataset.touch = String(coarse);
  viewport.dataset.mobileBoot = String(mode === "boot" && (coarse || viewport.clientWidth < 1100));
  stage.style.setProperty("--stage-scale", String(scale));
  stage.style.setProperty("--opening-width", `${width}px`);
  stage.style.setProperty("--opening-height", `${height}px`);
  stage.style.setProperty("--opening-scan-scale", String(Math.min(1, width / 1920)));
  stage.dataset.openingPortrait = String(width < height);
  const visible = window.visualViewport;
  const stageTop = (viewport.clientHeight - height * scale) / 2;
  stage.style.setProperty("--modal-top", `${Math.max(0, (visible?.offsetTop ?? 0) - stageTop) / scale}px`);
  stage.style.setProperty("--modal-height", `${Math.min(height, (visible?.height ?? viewport.clientHeight) / scale)}px`);
  $("#viewport").style.setProperty("--scale", String(scale));
  const marks = document.querySelector("#inspection-marks");
  marks?.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const layoutKey = JSON.stringify([width, height, scale, kind, devicePixelRatio]);
  if (layoutKey !== previousLayout) {
    previousLayout = layoutKey;
    scene?.resize();
    viewer?.resize();
    // 视口/缩放/档位变化后重算品牌右边界（仓库名与档位都会影响所需字距）
    fitBrand();
  }
  updateQualitySummary();
  requestAnimationFrame(() => {
    documentDecryption.refresh();
    const tab = document.querySelector<HTMLElement>(".detail-tabs button.active");
    const indicator = document.querySelector<HTMLElement>(".tab-indicator");
    if (tab && indicator) indicator.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
  });
}
window.addEventListener("resize", fit);
window.visualViewport?.addEventListener("resize", fit);
window.visualViewport?.addEventListener("scroll", fit);
matchMedia("(pointer: coarse)").addEventListener("change", fit);
fit();
if (typeof ResizeObserver !== "undefined") {
  const vp = $("#viewport");
  if (vp) new ResizeObserver(() => fit()).observe(vp);
}



const fileTicks: HTMLButtonElement[] = [];
// 档案刻度最多同时显示 TICK_WINDOW 根，超出时以选中项为中心开窗，
// 否则一列几十份档案会把刻度条撑出屏幕、压到右侧列切换器上。
const TICK_WINDOW = 13;
function rebuildFileTicks() {
  const container = $("#file-ticks");
  const files = columnFiles(fileLocation(selected).lane);
  const n = files.length;
  const selAt = Math.max(0, files.indexOf(selected));
  let start = 0;
  if (n > TICK_WINDOW) {
    start = Math.min(Math.max(selAt - Math.floor(TICK_WINDOW / 2), 0), n - TICK_WINDOW);
  }
  const end = Math.min(n, start + TICK_WINDOW);
  container.innerHTML = files
    .slice(start, end)
    .map((_, k) => `<button data-tick="${start + k}"></button>`)
    .join("");
  container.classList.toggle("clipped-start", start > 0);
  container.classList.toggle("clipped-end", end < n);
  fileTicks.length = 0;
  fileTicks.push(...container.querySelectorAll<HTMLButtonElement>("button"));
}

function setMode(next: Mode) {
  const previousMode = mode;
  rollingTitles.forEach(title => title.update({ animated: !prefs.reduced && next === "archive" }));
  if (next !== "archive") {
    rollingTitles.forEach(title => title.finish());
    hoverCode.finish();
    $("#hover-label").hidden = true;
  }
  if (next === "detail" && mode !== "detail") recordAccess();
  mode = next;
  audio.setScene(next);
  $("#stage").dataset.mode = next;
  // boot→档案态需重新应用右边界对齐；boot 动画会在本帧之后写 inline，故延后一帧。
  // 另外品牌此时可能尚未参与布局（boot="done" 在函数更后处才置位、字体也可能未加载，
  // 量到 0 宽会提前 return）——用有限次 rAF 重试直到量出有效宽度（上限 30 帧≈0.5s，
  // 失败也只是维持原样，不会死循环）。
  if (next === "boot") fitBrand();
  else scheduleBrandFit();
  if (previousMode !== next) fit();
  $("#boot").inert = next !== "boot";
  $("#boot").setAttribute("aria-hidden", String(next !== "boot"));
  $("#archive-ui").inert = next !== "archive" || Boolean(modal);
  $("#archive-ui").setAttribute("aria-hidden", String(next !== "archive"));
  $(".system-nav").inert = next === "boot" || Boolean(modal);
  $(".system-footer").inert = next === "boot" || Boolean(modal);
  if (next === "detail") {
    if (previousMode !== "detail") detailTransition.show(prefs.reduced);
  } else if (previousMode === "detail" || (next === "boot" && !$("#detail-ui").hidden)) {
    pendingDetailFocus = false;
    tabTransition.cancel();
    detailTransition.hide(prefs.reduced || next === "boot");
    if (!modal && next === "archive") $(".read-file").focus({ preventScroll: true });
  }
  $("#detail-ui").inert = next !== "detail" || Boolean(modal);
  scene?.setMode(next === "boot" ? "hidden" : next);
  // 详情态提清：进 detail 直接起步全清档（2026-10-16 用户第四次反馈「蒙一层」后改）。
  // 高 DPI 屏（125% 缩放=物理 1920×1080）上半清 1.33MP 仍是 0.8× 拉伸=持续发糊，
  // 只有全清 2.07MP 才是原生清晰度；帧率不足时阶梯自动降到半清/常规，低配机不受损。
  setDetailBoostLevel(next === "detail" ? 2 : 0);
  if (next === "archive") updateHoverLabel();
  if (next === "archive") tryApplyPendingGoto();
  if (next !== "boot") {
    bootSequence.reset();
    $("#selected-column").textContent = $("#archive-category").textContent ?? "";
    $("#stage").dataset.boot = "done";
  }
  if (next === "detail" && previousMode !== "detail") {
    renderDetail();
    pendingDetailFocus = true;
    if (!scene) {
      $("#detail-content").style.opacity = "1";
      $("#detail-content").style.translate = "0 0";
      $("#detail-content").inert = false;
    }
  }
}
function select(index: number, navigation?: ArchiveNavigation) {
  selected = (index + records.length) % records.length;
  columnMemory[fileLocation(selected).lane] = selected;
  if (mode === "detail") setMode("archive");
  activeTab = "overview";
  scene?.select(selected, navigation);
  updateSelection(navigation);
  const columnMove = navigation && "axis" in navigation && navigation.axis === "lane";
  audio.play(columnMove ? "column" : "tick", columnMove ? navigation.direction * .45 : 0);
}
function stepFile(direction: number) {
  const files = columnFiles(fileLocation(selected).lane);
  if (files.length < 2) return;
  select(
    files[(files.indexOf(selected) + direction + files.length) % files.length],
    { axis: "row", direction },
  );
}
function stepColumn(direction: number) {
  const lane = fileLocation(selected).lane;
  const next = wrap(lane + direction, archiveColumns.length);
  select(columnMemory[next], { axis: "lane", direction });
}
// —— 目录分层导航（A 方案）——
let currentDir = "";
const ROOT_LABEL = "MEMORY";

function dirSegments(dir: string) {
  return dir ? dir.split("/") : [];
}
function renderCrumbs() {
  const nav = $("#folder-crumbs");
  const parts = [`<button data-crumb="">${ROOT_LABEL}</button>`];
  let acc = "";
  for (const seg of dirSegments(currentDir)) {
    acc = acc ? acc + "/" + seg : seg;
    parts.push(`<i>／</i><button data-crumb="${escapeHtml(acc)}">${escapeHtml(seg)}</button>`);
  }
  nav.innerHTML = parts.join("");
}
function renderFolderMenu() {
  const prefix = currentDir ? currentDir + "/" : "";
  const counts = new Map<string, number>();
  for (const r of records) {
    const rel = r.dir.slice(prefix.length);
    if (!rel) continue;
    const name = rel.split("/")[0];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const menu = $("#folder-menu");
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  menu.innerHTML = items.length
    ? items.map(([name, count]) => `<button data-folder="${escapeHtml(name)}">${escapeHtml(name)}<span>${String(count).padStart(2, "0")}</span></button>`).join("")
    : '<div class="fm-empty">此层无子文件夹</div>';
}
function toggleFolderMenu(force?: boolean) {
  const menu = $("#folder-menu");
  const show = force ?? menu.hidden;
  if (show) renderFolderMenu();
  menu.hidden = !show;
  $("#folder-switch").setAttribute("aria-expanded", String(show));
}
/**
 * 宿主下发的目录定位（obsidian://rhine?dir=… 或主页「进入」按钮）。
 * boot 期间（开机动画 / 登录闸门）先挂起，等进入档案态再真正切目录。
 */
var pendingGotoDir: string | null = null;
function tryApplyPendingGoto() {
  if (pendingGotoDir === null) return;
  if (mode === "boot") return;
  const dir = pendingGotoDir;
  pendingGotoDir = null;
  applyView(dir);
}
function applyView(dir: string) {
  if (dir === currentDir) { toggleFolderMenu(false); return; }
  if (mode === "detail") setMode("archive");
  applyDirectory(dir);
  currentDir = dir;
  rebuildColumnMemory();
  selected = 0;
  activeTab = "overview";
  // 目录变了 → 卡片内容面图集要按新记录集重绘（否则墙上仍显示上一目录的笔记信息）。
  scene?.refreshContentAtlas();
  scene?.select(0);
  updateSelection();
  renderCrumbs();
  toggleFolderMenu(false);
  audio.play("page-open");
  notify(dir ? `已进入 ${dir}` : "已返回根目录");
}
/**
 * 宿主刷新（命令「刷新终端数据」或 vault 结构变化自动触发）：
 * 原地替换整套档案数据 —— 不重挂 iframe、不重放开机动画、不丢当前目录与选中项。
 * 目录被删/改名时逐级回退到仍然存在的上级；选中项越界则夹到末位。
 */
function applyHostRefresh(list: ArchiveRecord[] | undefined, silent: boolean) {
  if (!Array.isArray(list)) return;
  const survives = (dir: string) =>
    !dir || list.some((r) => r.dir === dir || r.dir.startsWith(dir + "/"));
  let dir = currentDir;
  while (dir && !survives(dir)) {
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  setData({ records: list });
  applyDirectory(dir);
  currentDir = dir;
  rebuildColumnMemory();
  // 开机/启动闸门阶段不改 DOM：那段时间由 boot 序列自己接管，
  // 只把数据源换新（开机结束后渲染到的就是最新数据），避免打断动画。
  if (mode === "boot") return;
  selected = records.length ? Math.min(selected, records.length - 1) : 0;
  activeTab = "overview";
  scene?.refreshContentAtlas();
  scene?.select(selected);
  updateSelection();
  renderCrumbs();
  updateHoverLabel();
  if (mode === "detail") {
    if (records.length) renderDetail();
    else setMode("archive");
  }
  if (!$("#folder-menu").hidden) renderFolderMenu();
  if (!silent) notify(`档案数据已刷新（共 ${records.length} 份）`);
}

let hoverIndex: number | null = null;
function updateHoverLabel() {
  const label = $("#hover-label");
  const r = records[hoverIndex ?? selected];
  if (!r || mode === "boot") { label.hidden = true; return; }
  const animated = !prefs.reduced && mode === "archive" && !label.hidden;
  label.hidden = false;
  hoverCode.update({ value: Number(r.id.slice(2)), animated });
  hoverTitle.update({ text: r.title, animated });
  $("#hover-folder").textContent = r.category;
}
function updateSelection(navigation?: ArchiveNavigation) {
  if (!records.length) return;
  const r = records[selected];
  const { lane } = fileLocation(selected);
  const files = columnFiles(lane);
  selectionTitle.update({ text: r.title, animated: !prefs.reduced && mode === "archive" });
  clearanceTitle.update({ text: r.clearance, animated: !prefs.reduced && mode === "archive" });
  categoryTitle.update({ text: r.category, animated: !prefs.reduced && mode === "archive" });
  const direction =
    navigation && "axis" in navigation
      ? navigation.direction > 0 ? "up" : "down"
      : "auto";
  selectedCode.update({
    value: Number(r.id.slice(2)),
    animated: !prefs.reduced && mode === "archive",
    direction,
  });
  fileCounter.update({
    value: files.indexOf(selected) + 1,
    animated: !prefs.reduced && mode === "archive",
    direction: navigation && "axis" in navigation && navigation.axis === "row" ? direction : "auto",
  });
  $(".count-total").textContent = String(files.length).padStart(2, "0");
  columnCounter.update({
    value: lane + 1,
    animated: !prefs.reduced && mode === "archive",
    direction: navigation && "axis" in navigation && navigation.axis === "lane" ? direction : "auto",
  });
  const columnTotal = document.querySelector("#column-total");
  if (columnTotal) columnTotal.textContent = String(archiveColumns.length).padStart(2, "0");
  columnTitle.update({ text: archiveColumns[lane] ?? "", animated: !prefs.reduced && mode === "archive" });
  // 第二行右侧=所属列名（与 columnTitle 同源，但这里常驻显示完整层级）
  $("#selected-column").textContent = archiveColumns[lane] ?? "";
  const banner = $("#folder-banner");
  if (navigation && "axis" in navigation && navigation.axis === "lane") {
    banner.classList.remove("flash");
    void banner.offsetWidth;
    banner.classList.add("flash");
  }
  rebuildFileTicks();
  fileTicks.forEach(button => {
    const index = Number(button.dataset.tick), record = records[index];
    if (record === undefined) { button.remove(); return; }
    button.dataset.select = String(index);
    button.setAttribute("aria-label", `选择档案 ${record.id} ${record.title}`);
    button.title = `${record.id} · ${record.title}`;
    button.classList.toggle("selected", index === selected);
    button.setAttribute("aria-pressed", String(index === selected));
  });
  const savedCounter = document.querySelector("#saved-count");
  if (savedCounter) savedCounter.textContent = String(saved.size).padStart(2, "0");
  updateHoverLabel();
}
function replayBoot() {
  if (!ready) return;
  closeModal(() => {
    bootRate = 1; // 手动重播（REINITIALIZE）走完整原速版
    bootStart = performance.now() / 1000 - 1.76 / BOOT_SCALE;
    lastStep = "";
    setMode(prefs.reduced ? "archive" : "boot");
    audio.restartBoot();
    scene?.select(0);
    selected = 0;
    updateSelection();
    audio.play("ui-tick");
  });
}
function openFile() {
  if (!ready) return;
  closeModal(() => {
    setMode("detail");
    audio.play("open");
  });
}
function openInObsidian() {
  const r = records[selected];
  if (!r?.path) return;
  postToHost({ type: "rhine-open", path: r.path });
  notify("已发送到 Obsidian 打开 ↗");
  audio.play("confirm");
}
function revealInHost() {
  const r = records[selected];
  if (!r?.path) return;
  postToHost({ type: "rhine-reveal", path: r.path });
  audio.play("confirm");
}
function toggleSaved() {
  const id = records[selected].id;
  if (saved.has(id)) saved.delete(id);
  else saved.add(id);
  try {
    localStorage.setItem("rhine-terminal-saved", JSON.stringify([...saved]));
  } catch {}
  const savedCounter = document.querySelector("#saved-count");
  if (savedCounter) savedCounter.textContent = String(saved.size).padStart(2, "0");
  const button = $<HTMLButtonElement>('[data-action="bookmark"]');
  const added = saved.has(id);
  button.firstChild!.textContent = added ? "− REMOVE FROM SAVED" : "＋ SAVE ARCHIVE";
  button.querySelector("span")!.textContent = added ? "已收藏" : "收藏档案";
  button.setAttribute("aria-pressed", String(added));
  bookmarkFeedback?.cancel();
  if (!prefs.reduced) bookmarkFeedback = button.animate(
    [{ backgroundColor: "#67634c" }, { backgroundColor: "#252820" }],
    { duration: 220, easing: "ease-out" },
  );
  audio.play("confirm");
  notify(saved.has(id) ? "档案已加入收藏" : "已取消收藏");
}
function renderDetail() {
  tabTransition.cancel();
  const r = records[selected];
  $("#object-id").textContent = "NO." + String(selected + 1).padStart(3, "0");
  $("#detail-content").innerHTML = `
  <div class="detail-kicker"><span>FILE ${r.id}</span><span>${escapeHtml(r.clearance)}</span></div>
  <h2>${escapeHtml(r.en)}</h2><div class="detail-title-cn">${escapeHtml(r.title)}<span>${escapeHtml(r.category)}</span></div>
  <div class="detail-rule"></div>
  <dl class="metadata"><div><dt>LOCATION / 位置</dt><dd>${escapeHtml(r.department)}</dd></div><div><dt>DATE / 日期</dt><dd>${escapeHtml(r.date)}</dd></div><div><dt>TAGS / 标签</dt><dd>${escapeHtml(r.lead || "—")}</dd></div><div><dt>STATUS / 状态</dt><dd><i></i>${escapeHtml(r.clearance)}</dd></div></dl>
  <div class="detail-tabs" role="tablist"><button id="tab-overview" class="active" role="tab" aria-controls="tab-panel" aria-selected="true" data-tab="overview">01 <span>概述</span></button><button id="tab-notes" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="notes">02 <span>要点</span></button><button id="tab-history" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="history">03 <span>访问日志</span></button><i class="tab-indicator" aria-hidden="true"></i></div>
  <div id="tab-panel" class="tab-panel" role="tabpanel">${overview()}</div>
  <div class="detail-actions"><button class="solid-button" data-action="reveal-vault" aria-label="在文件管理器中定位 ${escapeHtml(r.title)}">REVEAL FILE<span>显示源文件</span></button><button class="export-button" data-action="open-vault" aria-label="在 Obsidian 中打开 ${escapeHtml(r.title)}">OPEN IN OBSIDIAN <span>↗</span></button></div>
  <div class="detail-footnote"><span>${escapeHtml(r.path)}</span><span>${String(selected + 1).padStart(3, "0")} / ${String(records.length).padStart(3, "0")}</span></div>`;
  $("#detail-content").setAttribute("tabindex", "-1");
  documentDecryption.reset($("#detail-content"), prefs.reduced || !scene || scene.decryptionFrame.phase === "clear");
  setTab(activeTab, false);
}
function overview() {
  return `<div class="panel-label">ABSTRACT / 摘要</div><p>${escapeHtml(records[selected].abstract || "（暂无摘要）")}</p>`;
}
function setTab(tab: string, sound = true) {
  if (sound && tab === activeTab) return;
  activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => {
    const active = (b as HTMLElement).dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
    b.setAttribute("tabindex", active ? "0" : "-1");
  });
  const r = records[selected];
  const tabButton = $<HTMLButtonElement>(`[data-tab="${tab}"]`);
  const indicator = $(".tab-indicator");
  indicator.style.transition = sound ? "" : "none";
  indicator.style.transform = `translateX(${tabButton.offsetLeft}px) scaleX(${tabButton.offsetWidth})`;
  $("#tab-panel").setAttribute("aria-labelledby", tabButton.id);
  $("#tab-panel").innerHTML =
    tab === "overview"
      ? overview()
      : tab === "notes"
        ? `<div class="panel-label">KEY FINDINGS / 要点</div>${r.findings.length ? `<ol class="research-notes">${r.findings.map((f, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span>${escapeHtml(f)}</li>`).join("")}</ol>` : `<p class="log-note">该档案暂无结构化要点。</p>`}`
        : `<div class="panel-label">ACCESS LOG / 本次访问</div>${accessLog
            .filter((entry) => entry.id === r.id)
            .slice(0, 4)
            .map(
              (entry) =>
                `<div class="log-row"><span>${entry.time}</span><span>CL</span><b>READ AUTHORIZED</b></div>`,
            )
            .join("")}<p class="log-note">本次会话已通过身份验证。档案内容以当前终端可访问范围展示。</p>`;
  $("#tab-panel").scrollTop = 0;
  documentDecryption.refresh();
  if (sound) {
    tabTransition.reveal($("#tab-panel"), prefs.reduced);
    audio.play("ui-tick");
  }
}
function notify(message: string) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

function openModal(kind: NonNullable<typeof modal>) {
  if (!ready) return;
  if (!modal) {
    previousFocus = document.activeElement as HTMLElement;
    modalSiblings = [...$("#stage").children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.id !== "modal-root")
      .map((node) => ({ node, inert: node.inert }));
    modalSiblings.forEach(({ node }) => (node.inert = true));
  }
  modalClosing = false;
  modal = kind;
  searchQuery = "";
  filter = "全部档案";
  audio.play("page-open");
  renderModal();
}
function closeModal(afterClose?: () => void) {
  if (!modal) {
    afterClose?.();
    return;
  }
  if (modalClosing) return;
  modalClosing = true;
  audio.play("page-close");
  modalTransition!.hide(prefs.reduced, () => {
    modal = null;
    modalClosing = false;
    $("#modal-root").replaceChildren();
    modalTransition = undefined;
    modalSiblings.forEach(({ node, inert }) => (node.inert = inert));
    modalSiblings = [];
    $("#archive-ui").inert = mode !== "archive";
    $("#detail-ui").inert = mode !== "detail";
    previousFocus?.focus({ preventScroll: true });
    afterClose?.();
  });
}
function renderModal() {
  if (!modal) return;
  modalTransition?.dispose();
  $("#modal-root").innerHTML =
    `<div class="modal-backdrop"><section class="terminal-modal ${modal === "settings" ? "settings-modal" : ""}" role="dialog" aria-modal="true" aria-label="${modal === "settings" ? "系统设置" : modal === "saved" ? "收藏档案" : "档案检索"}"><div class="modal-top"><span>${galleryName} / ${modal === "settings" ? "SYSTEM PREFERENCES" : "ARCHIVE DIRECTORY"}</span><button data-action="close-modal" aria-label="关闭窗口">CLOSE <span>×</span></button></div>${modal === "settings" ? settingsMarkup() : `<h2>${modal === "saved" ? "SAVED ARCHIVES" : "ARCHIVE INDEX"}<small>${modal === "saved" ? "收藏档案" : "内部档案检索"}</small></h2><div class="search-field"><span>⌕</span><input id="archive-search" type="search" autocomplete="off" placeholder="输入档案编号、名称或位置" aria-label="检索档案"/><span class="key">ESC</span></div><div class="category-filters">${categories.map((c, i) => `<button data-filter="${escapeHtml(c)}" class="${i === 0 ? "active" : ""}">${escapeHtml(c)}</button>`).join("")}</div><div class="result-header"><span>FILE / 档案</span><span>DEPARTMENT / 位置</span><span>ACCESS</span></div><div id="search-results" class="search-results"></div><div class="modal-bottom"><span id="result-count"></span><span>INTERNAL DATABASE <i>●</i> CONNECTED</span></div>`}</section></div>`;
  const backdrop = $(".modal-backdrop");
  backdrop.hidden = true;
  modalTransition = new SurfaceTransition(backdrop, $(".terminal-modal"));
  modalTransition.show(prefs.reduced);
  if (modal === "settings") updateQualitySummary();
  if (modal === "settings") syncQualityUI(prefs.rendering);
  if (modal !== "settings") {
    renderResults();
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $("#archive-search").focus();
    });
  } else
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $('[data-action="close-modal"]').focus();
    });
  $("#modal-root")
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
}
function renderResults() {
  const results = records
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        (modal !== "saved" || saved.has(r.id)) &&
        (filter === "全部档案" || r.category === filter) &&
        `${r.id} ${r.title} ${r.en} ${r.department} ${r.lead}`
          .toLowerCase()
          .includes(searchQuery.toLowerCase()),
    );
  $("#search-results").innerHTML = results.length
    ? results
        .map(
          ({ r, i }) =>
            `<button class="result-row" data-result="${i}"><span class="result-name"><b>${r.id}</b><span>${escapeHtml(r.title)}<small>${escapeHtml(r.en)}</small></span>${saved.has(r.id) ? "<i>＋</i>" : ""}</span><span>${escapeHtml(r.department)}</span><span>AUTHORIZED <i>↗</i></span></button>`,
        )
        .join("")
    : `<div class="empty-results"><span>∅</span><strong>${modal === "saved" && !searchQuery ? "尚无收藏档案" : "没有匹配的档案"}</strong><p>${modal === "saved" && !searchQuery ? "读取档案时，选择 SAVE ARCHIVE 将其保存在此处。" : "尝试其他名称、编号，或切换分类。"}</p><button data-action="reset-search">${modal === "saved" ? "查看全部档案 →" : "重置检索 →"}</button></div>`;
  $("#result-count").textContent =
    `${String(results.length).padStart(2, "0")} RECORDS FOUND`;
}
function updateQualitySummary() {
  const summary = document.querySelector("#quality-summary");
  if (!summary) return;
  if (!scene) { summary.textContent = "3D 已关闭 · 三维模型与渲染资源已释放"; return; }
  const canvas = scene.renderer.domElement;
  const metrics = JSON.parse(canvas.parentElement?.dataset.renderQuality ?? "{}");
  summary.textContent = `${prefs.superPerformance ? "性能优先模式已启用 · 画质设置暂被覆盖，关闭后恢复 · " : autoTier >= 1 ? "已自动降档（保留阴影与磨砂质感）· 帧率回升后自动恢复 · " : ""}实际渲染 ${canvas.width} × ${canvas.height} · ${effectiveRenderQuality().antialias === "smaa" ? "SMAA" : "原始抗锯齿"} · 纹理 ${metrics.anisotropy ?? 1}×${metrics.limited ? " · 已达到缓冲上限" : ""}`;
}
function motionSettingsMarkup() {
  return `<div id="motion-preference-note" class="motion-preference-note"><p>${prefs.reduced
    ? `当前已减少动态效果。${matchMedia("(prefers-reduced-motion: reduce)").matches ? "系统也请求减少动画，可仅为本站启用完整动效。" : "关闭上方开关可恢复完整动效。"}`
    : "当前使用完整动效。"}</p>${prefs.reduced ? '<button data-action="enable-motion">启用完整动效并重播 ↻</button>' : ""}</div>`;
}
function settingsMarkup() {
  return `<h2>SYSTEM SETTINGS<small>终端偏好设置</small></h2><p class="settings-intro">CL <span>·</span> SESSION AUTHORIZED</p><div class="settings-list">${themeSettingsMarkup(prefs.colorTheme === "dark")}${audioSettingsMarkup(prefs)}<label><div><strong>PERFORMANCE FIRST / 性能优先</strong><span>进一步降低渲染分辨率与材质开销，动效保持完整；关闭后恢复原画质</span></div><input type="checkbox" data-pref="superPerformance" ${prefs.superPerformance ? "checked" : ""}/><i class="toggle"></i></label><label><div><strong>REDUCED MOTION</strong><span>跳过开机动画，简化选档、镜头和文字动效</span></div><input type="checkbox" data-pref="reduced" ${prefs.reduced ? "checked" : ""}/><i class="toggle"></i></label></div>${motionSettingsMarkup()}${qualityMarkup(prefs.rendering)}<div class="settings-shortcuts"><span>KEYBOARD CONTROLS</span><p><kbd>←</kbd><kbd>→</kbd> 切列 <kbd>↑</kbd><kbd>↓</kbd> 选档 <kbd>ENTER</kbd> 读取 <kbd>/</kbd> 检索 <kbd>ESC</kbd> 返回</p></div><div class="settings-bottom">${document.fullscreenEnabled ? '<button data-action="fullscreen">FULLSCREEN <span>↗</span></button>' : ""}<button data-action="restart">REINITIALIZE SYSTEM <span>↻</span></button></div><div class="modal-bottom"><span>MEMORY ARCHIVE TERMINAL · 使用 ${__RHINE_FONT_NAME__} 字体${__RHINE_FONT_LICENSE__ ? ` <a href="${assetUrl(__RHINE_FONT_LICENSE__)}" target="_blank" rel="noopener">字体许可</a>` : ""}</span><span>POWERED BY ${galleryName}</span></div>`;
}

document.addEventListener("input", (e) => {
  const slider = e.target as HTMLInputElement;
  if (slider.dataset.quality) {
    const output = document.querySelector<HTMLOutputElement>(`[data-quality-output="${slider.dataset.quality}"]`);
    if (output) output.value = `${slider.value}%`;
  }
  const volume = e.target as HTMLInputElement;
  if (volume.dataset.volume === "musicVolume" || volume.dataset.volume === "soundVolume") {
    prefs[volume.dataset.volume] = Number(volume.value) / 100;
    volume.closest("label")?.querySelector("output")?.replaceChildren(`${volume.value}%`);
    saveAudioPrefs();
  }
  if ((e.target as HTMLElement).id === "archive-search") {
    searchQuery = (e.target as HTMLInputElement).value;
    renderResults();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "quality-preset" && Object.hasOwn(qualityPresets, el.value)) {
    prefs.rendering = { ...qualityPresets[el.value as QualityPreset] };
    noteManualQualityChange();
    savePrefs();
  } else if (el.dataset.quality) {
    const key = el.dataset.quality as keyof RenderQuality;
    prefs.rendering = normalizeQuality({ ...prefs.rendering, [key]: key === "antialias" ? el.value : Number(el.value) });
    noteManualQualityChange();
    savePrefs();
  }
  if (el.dataset.pref) {
    const key = el.dataset.pref;
    if (key === "sound" || key === "music" || key === "reduced" || key === "quality" || key === "superPerformance") {
      (prefs as unknown as Record<string, boolean>)[key] = el.checked;
    }
    if (key === "sound" || key === "music") saveAudioPrefs(); else savePrefs();
    if (key === "reduced") {
      const note = $("#motion-preference-note");
      if (note) note.outerHTML = motionSettingsMarkup();
    }
    audio.play("confirm");
  }
});
document.addEventListener("click", (e) => {
  const themeButton = (e.target as Element).closest<HTMLElement>("[data-color-theme]");
  if (themeButton) { prefs.colorTheme = themeButton.dataset.colorTheme === "dark" ? "dark" : "light"; savePrefs(); return; }
  if (!started) return;
  if (modalClosing) return;
  const el = (e.target as Element).closest<HTMLElement>("button");
  if (!el) return;
  if (el.dataset.select) {
    select(Number(el.dataset.select));
    return;
  }
  if (el.dataset.crumb !== undefined) { applyView(el.dataset.crumb); return; }
  if (el.dataset.folder) {
    applyView(currentDir ? currentDir + "/" + el.dataset.folder : el.dataset.folder);
    return;
  }
  if (el.dataset.result) {
    const index = Number(el.dataset.result);
    closeModal(() => {
      select(index);
      openFile();
    });
    return;
  }
  if (el.dataset.filter) {
    filter = el.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === filter,
        ),
      );
    renderResults();
    return;
  }
  if (el.dataset.tab) {
    setTab(el.dataset.tab);
    return;
  }
  const action = el.dataset.action;
  if (action === "folder-menu") toggleFolderMenu();
  if (action === "sound-preview") audio.play("confirm");
  if (action === "skip") {
    finishBoot(() => setMode("archive"));
    audio.play("confirm");
  }
  if (action === "prev") stepFile(-1);
  if (action === "next") stepFile(1);
  if (action === "column-prev") stepColumn(-1);
  if (action === "column-next") stepColumn(1);
  if (action === "open") openFile();
  if (action === "open-vault") openInObsidian();
  if (action === "back") {
    setMode("archive");
    audio.play("back");
  }
  if (action === "search" || action === "saved" || action === "settings") {
    el.focus({ preventScroll: true });
    openModal(action);
  }
  if (action === "close-modal") closeModal();
  if (action === "reveal-vault") revealInHost();
  if (action === "reset-search") {
    modal = "search";
    searchQuery = "";
    filter = "全部档案";
    renderModal();
  }
  if (action === "replay" || action === "restart") {
    replayBoot();
  }
  if (action === "enable-motion") {
    prefs.reduced = false;
    savePrefs();
    replayBoot();
  }
  if (action === "fullscreen" && document.fullscreenEnabled) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement
        .requestFullscreen()
        .catch(() => notify("请使用 F11 进入全屏"));
  }
});
document.addEventListener("keydown", (e) => {
  if (!started) return;
  if (viewer?.isOpen) return;
  if (modalClosing) {
    e.preventDefault();
    return;
  }
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === "Escape") {
    if (modal) closeModal();
    else if (mode === "detail" || (mode === "boot" && ready)) { const sound = mode === "detail" ? "back" : "ui-tick"; if (mode === "boot") finishBoot(() => setMode("archive")); else setMode("archive"); audio.play(sound); }
    return;
  }
  if (modal && e.key === "Tab") {
    const focusables = [
      ...$("#modal-root").querySelectorAll<HTMLElement>(
        'button,input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
      ),
    ];
    const visible = focusables.filter(el => el.getClientRects().length > 0);
    const first = visible[0],
      last = visible.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
    return;
  }
  if (typing || modal || !ready) return;
  if (e.key === "Backspace" && mode === "archive" && currentDir) {
    e.preventDefault();
    applyView(dirSegments(currentDir).slice(0, -1).join("/"));
    return;
  }
  if (
    (e.target as HTMLElement).dataset.tab &&
    ["ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();
    const tabs = ["overview", "notes", "history"];
    setTab(
      tabs[(tabs.indexOf(activeTab) + (e.key === "ArrowRight" ? 1 : 2)) % 3],
    );
    $<HTMLButtonElement>(`[data-tab="${activeTab}"]`).focus();
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    if (mode === "boot") finishBoot(() => setMode("archive"));
    openModal("search");
  }
  if (e.key === "ArrowLeft" && mode !== "boot") {
    e.preventDefault();
    stepColumn(-1);
  }
  if (e.key === "ArrowRight" && mode !== "boot") {
    e.preventDefault();
    stepColumn(1);
  }
  if (["ArrowUp", "ArrowDown"].includes(e.key) && mode !== "boot") {
    e.preventDefault();
    stepFile(e.key === "ArrowUp" ? -1 : 1);
  }
  if (
    e.key === "Enter" &&
    (document.activeElement === document.body ||
      document.activeElement?.id === "detail-content" ||
      ["prev", "next", "column-prev", "column-next"].includes(
        (document.activeElement as HTMLElement)?.dataset.action ?? "",
      ) ||
      (document.activeElement as HTMLElement)?.dataset.select)
  ) {
    e.preventDefault();
    if (mode === "boot") finishBoot(() => setMode("archive"));
    else if (mode === "archive") openFile();
  }
});

const ease = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
function bootFrame(t: number, silent = false) {
  /* 先判定收尾，再更新画面：rAF 偶尔会跨过 22 秒直接跳到 welcome 段，
     若先 update 就会把 WELCOME 画出来，随后冻结/hide 变成一帧跳帧。 */
  /* 2D 片尾前 0.7s 预先启动主页入场：纸白幕在开机白场上完成，真正切到主页时
     展台已经展开，不会出现「白屏结束→又一张白纸→再展开」的两段白。 */
  if (t >= 17.1 && !homePreNotified) {
    homePreNotified = true;
    try {
      window.parent.postMessage({ source: "rhine-terminal", type: "rhine-home-pre" }, "*");
    } catch {
      /* ignore */
    }
  }
  /* 2D 开场在 t=17.7 结束（走完扫描环、进入 WELCOME 段之前）。
     注意 bootMotion 内部会 +5 秒：内部 WELCOME 从 22.76 起，对应 appTime 17.76。
     若按 22 收尾恰好落进 WELCOME，自然跑完就会先看 WELCOME 再硬切主页。
     3D 档案阵列只在主页「进入」之后出现——不再先播一段阵列。 */
  if (t >= 17.7) {
    finishBoot(() => setMode("archive"));
    return undefined;
  }
  audio.updateBoot(t, silent);
  const motion = bootSequence.update(t);
  let step: string = motion.step;
  if (step !== lastStep) {
    $("#stage").dataset.boot = step;
    lastStep = step;
  }
  $("#selected-column").textContent =
    step === "array"
      ? "SELECTING FILES...".slice(0, Math.max(0, Math.floor((t - 21.94) * 18)))
      : "";
  $("#stage").style.setProperty(
    "--entry-opacity",
    String(ease((t - 21.9) / 0.13)),
  );
  $(".callout-rule").style.transform = `scaleX(${ease((t - 22.08) / 0.9)})`;
  const reveal = ease((t - 22) / 0.4),
    lift = ease((t - 26) / 1.8),
    zoom = 0.55 * ease((t - 27.3) / 1.65) + 0.45 * ease((t - 29.0) / 5.0);
  return { reveal, lift, zoom, time: t };
}

const inspectionOverlay = new InspectionOverlay();
const documentDecryption = new DocumentDecryption();
document.fonts.addEventListener("loadingdone", () => {
  documentDecryption.refresh();
  // 品牌字重依赖 Noto/Novecento；字体晚到会让首次量宽偏小、字距偏大，故重算
  fitBrand();
});

// Host bridge: the Obsidian view pauses the loop when its leaf is inactive.
let hostPaused = false;
// 主页阶段：开机动画播完先切到 home-i 主页，由主页「进入」再落到档案阵列。
let homeStage = false;
let homeNotified = false;
let homePreNotified = false;
let bootEnded = false;
/** 开机动画结束：收到宿主「先进主页」指令就进主页；还没收到就等一小会儿再回退。 */
function finishBoot(fallback: () => void) {
  bootEnded = true;
  if (homeStage) {
    enterHomeStage();
    return;
  }
  window.setTimeout(() => {
    if (!homeNotified) fallback();
  }, 1200);
}
function enterHomeStage() {
  if (homeNotified) return;
  homeNotified = true;
  hostPaused = true;
  try {
    window.parent.postMessage({ source: "rhine-terminal", type: "rhine-home-ready" }, "*");
  } catch {
    /* ignore */
  }
}
// 主页盖住终端的这段时间里，先点亮档案阵列并渲染若干帧：用户点「进入」时
// 不必再等 setMode archive + 首帧（实测约 600ms 的卡顿）。预热只在主页阶段生效，
// 进入/恢复/暂停都会立即清除预热计时，绝不会让终端在真正可见后又被自动暂停。
let warmUntil = 0;
function warmArchive(dir?: string) {
  if (!ready || mode !== "boot") return;
  setMode("archive");
  // 直接预热主页「进入」要去的那一柜（默认「原始记录」）；只 setMode 会停在根视图，
  // 点击后仍要切目录，等于没预热。
  if (typeof dir === "string" && dir && dir !== currentDir) applyView(dir);
  warmUntil = performance.now() + 720;
  hostPaused = false;
}
// 任何真实交互都说明本视图在前台 —— 立即解除暂停，避免"画面已可见却仍被冻结"。
for (const type of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const) {
  window.addEventListener(type, () => { hostPaused = false; }, { passive: true, capture: true });
}
window.addEventListener("message", (event) => {
  const data = event.data as { source?: string; type?: string; action?: string } | null;
  if (data?.source !== "rhine-host") return;
  if (data.type === "rhine-home-stage") {
    homeStage = true;
    if (bootEnded && !homeNotified) enterHomeStage();
  }
  if (data.type === "rhine-warm-archive") {
    warmArchive((event.data as { dir?: string }).dir);
    return;
  }
  if (data.type === "rhine-enter-dir") {
    const payloadDir = (event.data as { dir?: string }).dir;
    warmUntil = 0;
    hostPaused = false;
    homeNotified = false;
    const targetDir = typeof payloadDir === "string" ? payloadDir : "";
    // 主页阶段已经预热过：档案阵列早就在这一层画好了，点「进入」时只需把
    // 现成的一帧交给宿主开始收拢，不必再等 setMode / 首帧（原来约 430ms）。
    const alreadyWarm = mode === "archive" && targetDir === currentDir;
    if (mode === "boot") setMode("archive");
    applyView(targetDir);
    if (alreadyWarm) {
      postToHost({ type: "rhine-enter-ready" });
      return;
    }
    // 等真正画出第一帧再让宿主淡出主页：否则切换过程中会先露出片尾白场。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => postToHost({ type: "rhine-enter-ready" }));
    });
    return;
  }
  if (data.type === "rhine-pause") { warmUntil = 0; hostPaused = true; }
  if (data.type === "rhine-resume") {
    warmUntil = 0;
    hostPaused = false;
    // 后台标签页里浏览器可能回收 WebGL 上下文（切走再切回后画面空白）→ 自愈。
    window.setTimeout(() => {
      if (!scene?.graphicsLost) return;
      notify("显示资源被回收，正在恢复…");
      scene.restoreGraphics();
      window.setTimeout(() => {
        if (!scene || scene.graphicsLost) {
          notify("正在重载视图…");
          window.setTimeout(() => window.location.reload(), 500);
        } else {
          notify("显示已恢复");
        }
      }, 1200);
    }, 320);
  }
  if (data.type === "rhine-reveal-result") {
    notify(data.action === "collapsed" ? "已收起文件列表" : "已在文件管理器中定位 ↗");
  }
  if (data.type === "rhine-goto-dir") {
    const payload = event.data as { dir?: string };
    pendingGotoDir = typeof payload.dir === "string" ? payload.dir : "";
    tryApplyPendingGoto();
  }
  if (data.type === "rhine-refresh") {
    const payload = event.data as { data?: { records?: ArchiveRecord[] }; silent?: boolean };
    applyHostRefresh(payload.data?.records, Boolean(payload.silent));
  }
});

let lastTime = 0,
  frameCount = 0,
  frameStart = performance.now(),
  fps = 0,
  lowFpsSeconds = 0,
  highFpsSeconds = 0;
function frame(ms: number) {
  if (hostPaused) { requestAnimationFrame(frame); return; }
  if (document.hidden) { requestAnimationFrame(frame); return; }
  try {
    frameBody(ms);
    lastDrawnAt = performance.now();
  } catch (error) {
    // 渲染循环自愈：任何一帧异常都不允许打断整条 rAF 链，
    // 否则画面会"莫名消失"（DOM 还在但永不重绘）。同时上报真实原因。
    frameCrashCount += 1;
    const message = error instanceof Error ? `${error.message}` : String(error);
    reportToHost(`渲染帧异常（第 ${frameCrashCount} 次）：${message}`);
    notify(`显示异常已拦截（${frameCrashCount}）——若画面持续异常请重开视图`);
    if (frameCrashCount >= 3 && !frameCrashReported) {
      frameCrashReported = true;
      reportToHost(`渲染连续异常，最近原因：${message}`);
    }
  }
  if (warmUntil && performance.now() >= warmUntil) {
    warmUntil = 0;
    hostPaused = true;
    // 告诉宿主这一帧已经可以交差：点击「进入」时宿主可立即开始 CRT 收拢，
    // 不必等被主页遮住的 iframe 回消息（实测会被节流约 300ms）。
    postToHost({ type: "rhine-warm-ready", dir: currentDir });
  }
  requestAnimationFrame(frame);
}

// —— 显示看护（原版"图像莫名消失"的正式对策）——
// 症状：DOM 全部正常、只有三维画面消失。已定位的两条成因：
//   a) 图形上下文被系统回收（显存压力/驱动重置）→ 画面变透明；
//   b) 渲染循环停顿（暂停信号未解除/切标签节流）→ 上一帧被丢弃后再无新帧。
// 对策：分级自愈 —— 先唤醒循环，再尝试恢复上下文，最后请宿主重构视图（并回到原位置）。
let lastDrawnAt = performance.now();
let recoverStage = 0;
let rebuildRequested = false;
function displayStatus(text: string | null) {
  const chip = document.querySelector<HTMLElement>("#display-status");
  if (!chip) return;
  if (!text) {
    chip.hidden = true;
    chip.textContent = "";
    return;
  }
  chip.hidden = false;
  chip.textContent = text;
}
function requestRebuild(reason: string) {
  if (rebuildRequested) return;
  rebuildRequested = true;
  displayStatus("显示无法自动恢复，正在重构视图…");
  reportToHost(`显示重构请求（${reason}）`);
  postToHost({ type: "rhine-rebuild", mode, index: selected, dir: currentDir });
  // 宿主若无响应（脚本异常等），退化为页面自刷新（数据是内联的，刷新不丢档案）。
  window.setTimeout(() => {
    try {
      window.location.reload();
    } catch {
      /* 忽略 */
    }
  }, 2500);
}
window.setInterval(() => {
  if (!started || !ready || rebuildRequested) return;
  // ① 数值污染：容器被隐藏的那一瞬尺寸为 0，取景换算产出 NaN/Infinity 并永久传染相机。
  //    此时上下文正常、帧率正常、DOM 完好，只有三维整幅消失 —— 只能靠体检发现。
  if (scene && !scene.healthy) {
    recoverStage += 1;
    displayStatus("显示数值异常，正在复位…");
    scene.repair();
    reportToHost(`相机数值异常（NaN）已复位（第 ${recoverStage} 次）`);
    if (recoverStage >= 4) requestRebuild("nan-poisoned");
    return;
  }
  const glLost = scene?.graphicsLost ?? false;
  const stalled = !document.hidden && !hostPaused && performance.now() - lastDrawnAt > 3000;
  if (!glLost && !stalled) {
    if (recoverStage) {
      recoverStage = 0;
      displayStatus(null);
    }
    return;
  }
  recoverStage += 1;
  if (stalled && !glLost) {
    // 循环停顿：解除暂停、强制下一帧继续绘制，不重建。
    hostPaused = false;
    displayStatus("显示循环停顿，正在唤醒…");
    return;
  }
  displayStatus("显示资源被系统回收，正在恢复…");
  const restored = scene?.restoreGraphics() ?? false;
  if (recoverStage >= 3 || !restored) requestRebuild(glLost ? "context-lost" : "stalled");
}, 1500);

let frameCrashCount = 0;
let frameCrashReported = false;
function frameBody(ms: number) {
  const time = ms / 1000;
  const theme = scene?.themeAmount ?? (prefs.colorTheme === "dark" ? 1 : 0);
  paintTheme(theme);
  viewer?.setTheme(theme);
  // 快放版（当天再次进入）时间轴按曲线压缩，不是匀速加速。
  const bootElapsed = (time - bootStart) / BOOT_SCALE;
  let bootT: number;
  if (bootRate === 1) {
    bootT = bootElapsed;
  } else {
    // 把已走过的真实时长归一化到 [0,1]，再经曲线映射回胶片时间，收尾正好落在 BOOT_REPLAY_CUT。
    const span = BOOT_REPLAY_CUT - BOOT_START_T;
    const wall = span / bootRate;
    const u = Math.min(1, Math.max(0, (bootElapsed - BOOT_START_T) / wall));
    // 曲线而非匀速：速度在 1.8x 上叠加 +-42% 的正弦调制（起缓 -> 中段快 -> 收尾再缓），
    // 全程单调（最慢 1.04x、最快 2.56x，均不慢于原速），总时长与原来一致。
    const k = 0.42;
    const e = u - (k / (2 * Math.PI)) * Math.sin(2 * Math.PI * u);
    bootT = BOOT_START_T + span * e;
  }
  let cinema: ReturnType<typeof bootFrame> =
    mode === "boot" && ready ? bootFrame(bootT, bootRate !== 1) : undefined;
  if (mode === "boot" && bootRate !== 1) {
    // 快放版收尾（v8.9.17）：25.5 处直接从纸底切到阵列同样是一帧硬切（实测 bg 1→0）。
    // 这里在收尾前 0.32 胶片秒内把纸底渐隐，使切走那一刻本来就只剩阵列——
    // 与首播走白场溶解后的交接观感一致，不再有一次明度跳变。
    const tail = BOOT_REPLAY_CUT - 0.32;
    if (bootT >= tail) {
      const back = $("#boot-background");
      if (back) back.style.opacity = String(1 - ease((bootT - tail) / 0.32));
    }
  }
  if (mode === "boot" && bootRate !== 1 && bootT >= BOOT_REPLAY_CUT) {
    // 快放版到此收尾：阵列已展开，直接进墙（不自动选档、不进详情）。
    finishBoot(() => setMode("archive"));
    cinema = undefined;
  }
  if (!viewer?.isOpen && (!cinema || cinema.time >= 21.9)) scene?.update(time, cinema);
  viewer?.update(time);
  if (scene && mode === "detail") {
    documentDecryption.update(time, scene.decryptionFrame, prefs.reduced);
    $("#detail-content").style.opacity = String(scene.detailVisibility);
    $("#detail-content").style.translate =
      `0 ${(1 - scene.detailVisibility) * 18}px`;
    $("#detail-content").inert = scene.detailVisibility < 0.1;
    if (pendingDetailFocus && scene.detailVisibility >= 0.1 && !modal && !viewer?.isOpen) {
      $("#detail-content").focus({ preventScroll: true });
      pendingDetailFocus = false;
    }
  }
  $("#stage").style.setProperty("--detail-shade", String(mode === "boot" ? 0 : scene?.detailVisibility ?? 0));
  const currentScene = scene;
  if (currentScene) inspectionOverlay.render(currentScene.decryptionFrame,
    (x, y) => currentScene.projectCard(x, y), Boolean(cinema));
  if (Math.floor(time) !== lastTime) {
    lastTime = Math.floor(time);
    updateFooterClock(new Date(), !prefs.reduced);
  }
  frameCount++;
  if (ms - frameStart > 1000) {
    fps = (frameCount * 1000) / (ms - frameStart);
    frameStart = ms;
    frameCount = 0;
    $("#three-scene").dataset.fps = String(Math.round(fps));
    // 逐级自动降档：先降到「省电但保玻璃」，仍然偏低才切性能优先；明显恢复后再逐级升回。
    // 手动开启「性能优先」时锁定最高档，不参与自动回收。
    // 手动改画质后的观察窗口（15 秒）内不降档——用户选的画质必须先被看到；
    // 窗口过后若帧率确实撑不住，计时从零重新开始逐级降，流畅底线不变。
    const inQualityHold = performance.now() < qualityHoldUntil;
    if (ready && mode !== "boot" && !prefs.superPerformance && inQualityHold) {
      lowFpsSeconds = 0;
      highFpsSeconds = 0;
    } else if (ready && mode !== "boot" && !prefs.superPerformance && !autoTierTuned().silent) {
      // 性能档（silent）用户整段跳过：已选档位即底线，不降也不升（见 autoTierTuned 注释）。
      const tunedTier = autoTierTuned();
      if (fps > 0 && fps < tunedTier.low) {
        highFpsSeconds = 0;
        lowFpsSeconds += 1;
        if (lowFpsSeconds >= 4 && autoTier < 1) setAutoTier(autoTier + 1);
      } else if (fps >= tunedTier.high) {
        lowFpsSeconds = 0;
        highFpsSeconds += 1;
        if (highFpsSeconds >= 12 && autoTier > 0) setAutoTier(autoTier - 1);
      } else {
        lowFpsSeconds = 0;
        highFpsSeconds = 0;
      }
    }
    // 详情态提清的帧率阶梯：全清撑不住 → 先退半清（1536×864，帧率≈1.5×）；
    // 半清仍撑不住 → 收回常规档。半清档跑顺可回全清。流畅红线优先于清晰度。
    // 淡出未到位（阵列还没停画）的窗口期暂停降档计数——停画后帧率会阶跃回升，
    // 此时降档等于在动画最贵的 3 秒误判整机不行（2026-10-15 低配适配）。
    const cullPending = Boolean(scene && !scene.arrayCulled && scene.arrayFadeAmount > 0.15);
    if (ready && mode === "detail" && detailBoostLevel > 0 && !cullPending) {
      const tuned = detailBoostTuned();
      if (detailBoostLevel === 2) {
        if (fps > 0 && fps < tuned.full) {
          detailBoostLowSeconds += 1;
          if (detailBoostLowSeconds >= 4) setDetailBoostLevel(1, tuned.silent ? undefined : "详情画面已降为半清档以保证流畅");
        } else detailBoostLowSeconds = 0;
      } else {
        if (fps > 0 && fps < tuned.mid) {
          detailBoostLowSeconds += 1;
          if (detailBoostLowSeconds >= 4) setDetailBoostLevel(0, tuned.silent ? undefined : "详情画面已恢复常规分辨率以保证流畅");
        } else {
          detailBoostLowSeconds = 0;
          if (fps >= tuned.recover) {
            detailBoostHighSeconds += 1;
            if (detailBoostHighSeconds >= 8) setDetailBoostLevel(2);
          } else detailBoostHighSeconds = 0;
        }
      }
    }
  }
  return;
}
function bindScene(scene: ArchiveScene, cell?: { lane: number; row: number }) {
    scene.select(selected, cell ? { cell } : undefined);
    scene.onSelect = (i, cell) => {
      if (mode !== "archive" || modal || viewer?.isOpen) return;
      select(i, cell ? { cell } : undefined);
    };
    scene.onNavigate = (axis, direction) => {
      if (mode !== "archive" || modal || viewer?.isOpen) return;
      if (axis === "lane") stepColumn(direction);
      else stepFile(direction);
    };
    scene.onHover = (i) => {
      hoverIndex = i;
      updateHoverLabel();
    };
}

/** 场景 + 开机字体预载（gated 与常规进场共用）。分段设上限：场景资源慢（大 GLB +
 *  图集纹理）与字体慢是两类问题，分开计时既不会互相拖累，也能在诊断行里说清是谁慢。
 *  任何一环超时都降级继续，绝不把进场停在「正在准备终端…」。 */
async function loadBootAssets(target: ArchiveScene) {
  setEntryStage("正在载入三维资源 …");
  await withTimeout(target.load(), 30000, "三维资源载入");
  setEntryStage("正在载入字体 …");
  await withTimeout(
    Promise.all([
      loadBootWebfonts(),
      document.fonts.load("300 20px MiSans, 'Noto Sans SC'", "ACCESS WELCOME TO INTERNAL DATABASE"),
      document.fonts.load("400 20px MiSans, 'Noto Sans SC'", `身份信息确认请求已接收开始处理权限验证通过欢迎访问莱茵生命内部资料档案编号保密级别商业区选择档案：0123456789 CL ${galleryName}`),
      document.fonts.load("600 20px MiSans, 'Noto Sans SC'", "SYNTHESIZE INFORMATION ANALYSIS OS"),
      document.fonts.load("700 20px MiSans, 'Noto Sans SC'", `${galleryName} WELCOME TO INTERNAL DATABASE`),
    ]),
    12000,
    "字体载入",
  );
  setEntryStage("正在准备界面 …");
}

/**
 * 进场内嵌闸门流（2026-10-18 用户指导）：点击「点击进入 →」→ 内容块整体左移 →
 * 右侧滑出方形登录卡 → 验证成功 → 内容块回位 → 接原开机动画（丝滑无空窗）。
 * 场景与字体在点击前就预载好（载入期 records 为空是安全的：场景只建 160 格
 * 循环池与网格，内容面图集在验证成功、数据注入后 refreshContentAtlas 重绘）。
 * 验证与密码哈希全在宿主（plugin-main.ts）；通过前宿主不下发任何档案数据。
 */
async function startGated() {
  try {
    scene = new ArchiveScene($("#three-scene"));
    scene.setTheme(prefs.colorTheme === "dark", true);
    await loadBootAssets(scene).catch(error => {
      console.error(error);
      postToHost({ type: "rhine-error", message: "部分资源载入失败（可能是字体或三维模型），终端将以降级模式运行。" });
    });
    if (scene) bindScene(scene);
    savePrefs();
    if (entry) {
      // 点击由 StartupGate 接管：解锁声音后才开闸门（start 回调里路由到 openGate）。
      entry.ready();
    } else {
      // 声音全关：没有手势步骤，稍候自动滑出登录卡。
      window.setTimeout(() => void openGate(false), prefs.reduced ? 100 : 500);
    }
  } catch (error) {
    console.error(error);
    postToHost({ type: "rhine-error", message: "三维档案资源未能载入。请确认 Obsidian 已启用硬件加速。" });
    loading.innerHTML =
      '<div class="error-state"><strong>CONNECTION INTERRUPTED</strong><p>三维档案资源未能载入。请确认 Obsidian 已启用硬件加速，然后重新打开视图。</p></div>';
  }
}

let gateOpened = false;
async function openGate(silent: boolean) {
  if (gateOpened) return;
  gateOpened = true;
  const list = await runGateFlow(loading, prefs.reduced);
  if (list === null) { gateOpened = false; return; }
  setData({ records: list });
  applyDirectory("");
  rebuildColumnMemory();
  renderCrumbs();
  if (!list.length) {
    loading.innerHTML =
      '<div class="error-state"><strong>DATABASE EMPTY</strong><p>指定范围内没有找到任何 Markdown 笔记。请在插件设置中调整档案目录。</p></div>';
    return;
  }
  // 图集在场景预载时是按空记录建的，数据到位后先重绘再选中。
  scene?.refreshContentAtlas();
  ready = true;
  select(0);
  completeStartup(silent);
}

async function start() {
  if (gateRequired) { void startGated(); return; }
  try {
    if (!records.length) {
      loading.innerHTML =
        '<div class="error-state"><strong>DATABASE EMPTY</strong><p>指定范围内没有找到任何 Markdown 笔记。请在插件设置中调整档案目录。</p></div>';
      return;
    }
    scene = new ArchiveScene($("#three-scene"));
    scene.setTheme(prefs.colorTheme === "dark", true);
    await loadBootAssets(scene).catch(error => {
      console.error(error);
      postToHost({ type: "rhine-error", message: "部分资源载入失败（可能是字体或三维模型），终端将以降级模式运行。" });
    });
    if (scene) bindScene(scene);
    savePrefs();
    ready = true;
    select(0);
    const recovering = Boolean(
      (window as unknown as { RHINE_RECOVER?: unknown }).RHINE_RECOVER,
    );
    if (entry && !recovering) entry.ready();
    else completeStartup(false);
  } catch (error) {
    console.error(error);
    postToHost({ type: "rhine-error", message: "三维档案资源未能载入。请确认 Obsidian 已启用硬件加速。" });
    loading.innerHTML =
      '<div class="error-state"><strong>CONNECTION INTERRUPTED</strong><p>三维档案资源未能载入。请确认 Obsidian 已启用硬件加速，然后重新打开视图。</p></div>';
  }
}
function completeStartup(silent: boolean) {
  if (started || !ready) return;
  started = true;
  if (silent) {
    prefs.sound = false;
    prefs.music = false;
    saveAudioPrefs();
  }
  audio.releaseEntry();
  const recover = (
    window as unknown as { RHINE_RECOVER?: { mode?: string; index?: number; dir?: string } }
  ).RHINE_RECOVER;
  const fade = prefs.reduced ? 0 : 600;
  if (recover) {
    // 显示重构后的快速复位：不播开机流程，直接回到出事前的目录/档案。
    if (typeof recover.dir === "string" && recover.dir) {
      applyDirectory(recover.dir);
      rebuildColumnMemory();
      renderCrumbs();
    }
    if (
      typeof recover.index === "number" &&
      recover.index >= 0 &&
      recover.index < records.length
    ) {
      selected = recover.index;
    }
    bootRate = 1;
    bootStart = performance.now() / 1000 - 1.76 / BOOT_SCALE - 60;
    updateSelection();
    scene?.select(selected);
    setMode(recover.mode === "detail" ? "detail" : "archive");
    notify("显示已重构，已回到原位置");
  } else {
    // 开机动画：每天首次按原速完整播到 2D 片尾（t=17.7，进入 WELCOME 之前），随后交给主页；
    // 当天再次进入改播加速版（bootRate>1），同样到 2D 片尾为止，不再播阵列——见 frameBody 的 BOOT_REPLAY_CUT。
    // REINITIALIZE 手动重启走 replayBoot 独立路径，原速重播，不受此分支影响。
    const replayed = bootPlayedToday();
    if (prefs.reduced) {
      bootRate = 1;
      bootStart = performance.now() / 1000 - 1.76 / BOOT_SCALE - 60;
      // 减少动态效果：不播开机动画，但仍要经过主页（等宿主 rhine-home-stage 到达后再定）
      finishBoot(() => setMode("archive"));
    } else if (replayed) {
      bootRate = BOOT_REPLAY_RATE;
      bootStart = performance.now() / 1000 - 1.76 / BOOT_SCALE + fade / 1000;
      setMode("boot");
    } else {
      bootRate = 1;
      markBootPlayed();
      audio.restartBoot();
      bootStart = performance.now() / 1000 - 1.76 / BOOT_SCALE + fade / 1000;
      setMode("boot");
    }
  }
  $("#stage").inert = false;
  $(".mobile-entry").inert = false;
  loading.classList.add("loaded");
  loading.inert = true;
  setTimeout(() => {
    const restoreFocus = loading.contains(document.activeElement) || document.activeElement === document.body;
    loading.remove();
    if (entry && restoreFocus) {
      const skip = $("#skip");
      const target = mode === "boot" && skip.getClientRects().length ? skip : $(".read-file");
      target.focus({ preventScroll: true });
    }
  }, fade);
  requestAnimationFrame(frame);
}
// 诊断钩子（只读）：供自测脚本检查场景健康度、模式与相机数值。
(window as unknown as { __rhine?: unknown }).__rhine = {
  get scene() { return scene; },
  get mode() { return mode; },
  get started() { return started; },
  get ready() { return ready; },
};

// 闸门模式（宿主不下发 RHINE_DATA）：先不填数据，等待验证成功后由 start() 内注入。
if (!gateRequired) {
  try {
    setData(window.RHINE_DATA ?? { records: [] });
  } catch (error) {
    // 宿主注入的数据形态异常（历史 bug：多包一层外壳）→ 报错但绝不卡死。
    reportEntryError("档案数据异常", error);
    setData({ records: [] });
  }
  applyDirectory("");
  rebuildColumnMemory();
  renderCrumbs();
  updateSelection();
  void start();
} else {
  void startGated();
}

// 兜底：15s 内仍未就绪则放行「点击进入」并说明原因，避免任何未预期挂起把界面锁死。
// 闸门卡显示期间（gateOpened / gate-open）不算卡住，不能被这条兜底打断。
window.setTimeout(() => {
  if (started || ready || gateOpened) return;
  if (loading.classList.contains("gate-open") || loading.classList.contains("gate-done")) return;
  reportEntryError("进场超时", "资源未就绪，已允许直接进入（降级）");
  if (entry) entry.ready();
  else void openGate(false);
}, 15000);
