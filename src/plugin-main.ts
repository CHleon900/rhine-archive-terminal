import {
  App,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_RHINE = "rhine-archive-view";
const VIEW_TYPE_RHINE_HOME = "rhine-home-view";
const HOME_THEME_BRIDGE = `<script>(function(){try{var p=window.parent&&window.parent.document;var b=p&&p.body;function apply(){try{var d=!!(b&&b.classList.contains("theme-dark"));document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){}}apply();try{new MutationObserver(apply).observe(b,{attributes:true,attributeFilter:["class"]});}catch(e){}})();<\/script>`;

/** 显示重构时带回来的现场信息（终端侧在画面无法恢复时发出）。 */
interface RhRecover {
  mode: string;
  index: number;
  dir: string;
}

import { RhineDocView, VIEW_TYPE_RHINE_DOC, type DocRecord } from "./rhine-doc-view";
import {
  hashPassword,
  verifyPassword,
  LoginBackoff,
  dayStamp,
  el,
  type StoredPassword,
} from "./plugin-gate";
const PLUGIN_DIR = ".obsidian/plugins/rhine-archive-terminal";

interface RhineSettings {
  folder: string;
  /** 密码闸门（2026-10-18）；为空=功能未启用，流程与从前完全一致。 */
  password?: StoredPassword;
  /** 已通过闸门的日期（sv-SE 本地日期）；当天再开只播「已授权」短动画。 */
  passwordDay?: string;
}

const DEFAULT_SETTINGS: RhineSettings = {
  folder: "",
};

interface ArchiveRecordData {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  path: string;
  /** Relative parent directory ("" = root), "/" separated. */
  dir: string;
  /** 笔记内第一张图片的完整资源 URL（详情卡封面带用；无图=undefined）。 */
  imageUrl?: string;
}

interface ArchiveData {
  records: ArchiveRecordData[];
  categories: string[];
  columns: string[];
}

const MAX_COLUMNS = 9;

function stripMarkdown(line: string) {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*[-*+]\s*(\[[ x]?\]\s*)?/, "")
    .replace(/^\s*>\s*/, "")
    .replace(/!\[\[([^\]|]*)(\|[^]]*)?\]\]/g, "$1")
    .replace(/\[\[([^\]|]*)(\|([^\]]*))?\]\]/g, (_m, _a, _b, c) => c || _a)
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\$\$?[^$]*\$\$?/g, "")
    .trim();
}

export class RhineArchiveView extends ItemView {
  private plugin: RhineArchivePlugin;
  private iframe: HTMLIFrameElement | null = null;
  /** 主页（home-i）：开机动画开始时就预加载，真正切换时只做透明度交叉淡入，避免中间露白。 */
  private homeIframe: HTMLIFrameElement | null = null;
  /** 主页与终端之间的纸色遮片：主页首帧尚未合成时挡住终端最后一帧，防止闪出 WELCOME 画面。 */
  private homeCover: HTMLDivElement | null = null;
  /** 主页文档是否已 load 完成（预加载完成前切换会露白，故先等它）。 */
  private homeReady = false;
  private homeLoad: Promise<void> | null = null;
  private homeGen = 0;
  /** 已请求显示主页。 */
  private homePending = false;
  /** 主页入场已启动（片尾前预热或 showHome 触发），避免重复从白幕重播。 */
  private homeIntroStarted = false;
  /** 主页遮住终端时是否已预热出档案阵列首帧，以及那一帧所在的目录。 */
  private homeWarm = false;
  private homeWarmDir = "";
  private homeListener: ((event: MessageEvent) => void) | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;
  private errorNotice: Notice | null = null;
  /** 已扫描的档案数据（供显示重构时原样重挂，无需重新扫描）。 */
  private archiveData: ArchiveData | null = null;
  private leafChangeListener: ((leaf: WorkspaceLeaf | null) => void) | null = null;
  /** 本视图所在的 .workspace-tabs：只在它上面挂稳定类，CSS 不再用 :has()，避免侧栏折叠时全窗重算闪一下。 */
  private hostTabsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RhineArchivePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType() { return VIEW_TYPE_RHINE; }
  getDisplayText() { return "莱茵档案终端"; }
  getIcon() { return "box"; }

  /** 给承载本视图的标签栏打稳定类（替代 CSS :has()，侧栏开合不会触发全窗重算闪烁）。 */
  private tagHostChrome() {
    const tabs = this.containerEl.closest(".workspace-tabs") as HTMLElement | null;
    if (tabs) {
      tabs.classList.add("rhine-archive-tabs");
      this.hostTabsEl = tabs;
    }
  }

  private untagHostChrome() {
    if (this.hostTabsEl) {
      this.hostTabsEl.classList.remove("rhine-archive-tabs");
      this.hostTabsEl = null;
    } else {
      this.containerEl.closest(".workspace-tabs")?.classList.remove("rhine-archive-tabs");
    }
  }

  async onOpen() {
    this.tagHostChrome();
    // Obsidian 可能在视图打开后重建标签栏 DOM，晚一点再补一次类名。
    window.setTimeout(() => this.tagHostChrome(), 260);
    window.setTimeout(() => this.tagHostChrome(), 1200);
    this.contentEl.empty();
    this.contentEl.addClass("rhine-archive-content");
    this.contentEl.style.padding = "0";
    this.contentEl.style.overflow = "hidden";
    this.contentEl.style.position = "relative";
    // 闸门改为 iframe 进场流程内嵌（2026-10-18 用户指导）：
    // 设了密码时终端进场流程**总是**先显示登录卡——
    // ① 今天还没通过 → 挂空终端并注入 RHINE_GATE（数据绝不下发，验证通过才给）；
    // ② 当天已通过 → 数据随挂载一起下发，卡片上直接点「登录」放行（当天不再输入）。
    // 无密码 → 原 unlockAndMount（扫数据后挂载，无闸门）。
    const settings = this.plugin.settings;
    if (!settings.password) {
      await this.unlockAndMount();
    } else if (settings.passwordDay !== dayStamp()) {
      await this.mountTerminal(null, undefined, { authorized: false });
    } else {
      await this.unlockAndMount({ authorized: true });
    }
  }

  /**
   * 密码闸门界面（宿主侧 DOM；终端色板与字体与 iframe 内保持一致）。
      注：2026-10-18 起闸门已改由 iframe 进场流程内嵌（gate-card.ts），此宿主层
      面板保留为兜底（mountTerminal 的 RHINE_GATE 注入失败等异常场景才会走到）；
      正常路径不再调用。 */
  private renderGate() {
    const root = this.contentEl;
    root.empty();
    root.style.cssText +=
      "display:flex;align-items:center;justify-content:center;background:#e8e5e1;color:#151714;" +
      "font-family:'MiSans','Noto Sans SC','Microsoft YaHei',system-ui,sans-serif;";
    const panel = el("div", "display:flex;flex-direction:column;gap:18px;width:min(420px,80%);");
    panel.appendChild(el("div", "font-size:11px;letter-spacing:.34em;color:#7a7873;", "INTERNAL DATABASE"));
    panel.appendChild(el("div", "font-size:30px;font-weight:700;letter-spacing:.04em;", "需要访问许可"));
    panel.appendChild(el("div", "font-size:12px;letter-spacing:.22em;color:#7a7873;", "ACCESS PERMISSION REQUIRED"));
    const line = el(
      "div",
      "display:flex;align-items:center;gap:10px;border-bottom:1px solid #151714;padding:10px 2px;margin-top:6px;",
    );
    line.appendChild(el("span", "font-size:13px;letter-spacing:.18em;color:#7a7873;", "PASSWORD"));
    line.appendChild(el("span", "font-size:20px;color:#e7c69b;", "›"));
    const input = el("input", "flex:1;border:0;outline:0;background:transparent;color:#151714;font:inherit;font-size:19px;letter-spacing:.22em;");
    input.type = "password";
    input.autocomplete = "current-password";
    line.appendChild(input);
    panel.appendChild(line);
    const status = el("div", "font-size:12px;letter-spacing:.08em;min-height:18px;color:#963e32;");
    panel.appendChild(status);
    const submit = el(
      "button",
      "align-self:flex-start;margin-top:4px;padding:10px 18px;border:1px solid #151714;background:transparent;" +
        "color:#151714;font:inherit;font-size:13px;letter-spacing:.2em;cursor:pointer;",
      "VERIFY →",
    );
    panel.appendChild(submit);
    root.appendChild(panel);

    const backoff = new LoginBackoff();
    let busy = false;
    const attempt = async () => {
      if (busy) return;
      if (backoff.blocked) {
        status.textContent = `访问被挂起，请 ${Math.ceil(backoff.remaining / 1000)} 秒后再试`;
        return;
      }
      const value = input.value;
      if (!value) {
        status.textContent = "请输入访问密码";
        return;
      }
      busy = true;
      submit.textContent = "VERIFYING …";
      status.textContent = "";
      const ok = await verifyPassword(value, this.plugin.settings.password);
      busy = false;
      submit.textContent = "VERIFY →";
      if (!ok) {
        backoff.fail();
        status.textContent = backoff.blocked
          ? `ACCESS DENIED · 请 ${Math.ceil(backoff.remaining / 1000)} 秒后再试`
          : "ACCESS DENIED · 密码不正确";
        root.animate(
          [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
          { duration: 220, easing: "ease-out" },
        );
        input.value = "";
        input.focus();
        // 退避文案自动倒数并在到期后解除（真机 bug：首版文案写死后永不刷新、
        // 永不消失，用户要再按一次 Enter 才知道已解锁——把「等解锁」也堵死）。
        startBlockedTicker();
        return;
      }
      backoff.reset();
      this.plugin.settings.passwordDay = dayStamp();
      await this.plugin.saveSettings();
      await this.unlockAndMount();
    };
    let ticker: number | undefined;
    const startBlockedTicker = () => {
      if (ticker !== undefined) return;
      ticker = window.setInterval(() => {
        if (!document.contains(input)) {
          window.clearInterval(ticker);
          ticker = undefined;
          return;
        }
        if (backoff.blocked) {
          status.textContent = `ACCESS DENIED · 请 ${Math.ceil(backoff.remaining / 1000)} 秒后再试`;
        } else {
          window.clearInterval(ticker);
          ticker = undefined;
          status.textContent = "挂起已解除 · 可重新验证";
          input.focus();
        }
      }, 500);
    };
    submit.addEventListener("click", () => void attempt());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") void attempt();
    });
    window.setTimeout(() => input.focus(), 30);
  }

  /**
   * 扫描数据 → 挂载终端。gate 传入时终端进场流程内嵌登录卡：
   * {authorized:true} = 当天已通过，卡片照常显示但点「登录」直接放行（数据本次下发）。
   * 宿主层 ACCESS GRANTED 扫线已由这张卡取代，不再播放。
   */
  private async unlockAndMount(gate?: { authorized: boolean }) {
    const data = await this.plugin.buildArchiveData();
    if (!data.records.length) {
      this.renderEmpty(data);
      return;
    }
    this.plugin.indexRecords(data.records);
    this.archiveData = data;
    await this.mountTerminal(data, undefined, gate);
  }

  /**
   * iframe 闸门验证（2026-10-18 用户指导的新流程）：终端进场画面里输入密码后
   * 发 rhine-gate-verify，这里校验+退避，结果经 rhine-gate-result 回给终端；
   * 通过才扫描数据并整体下发（在此之前数据绝不出宿主）。回传 records 为空
   * 数组表示 vault 无档案（终端自己显示 DATABASE EMPTY）。
   */
  private gateBusy = false;
  private async handleGateVerify(password: string) {
    if (this.gateBusy) return;
    this.gateBusy = true;
    try {
      if (!this.plugin.settings.password) {
        // 设置页刚清掉密码的竞态：直接放行。
        this.postGateResult({ ok: true });
        return;
      }
      if (this.gateBackoff.blocked) {
        this.postGateResult({ ok: false, remaining: Math.ceil(this.gateBackoff.remaining / 1000) });
        return;
      }
      const ok = await verifyPassword(password, this.plugin.settings.password);
      if (!ok) {
        this.gateBackoff.fail();
        this.postGateResult({
          ok: false,
          remaining: this.gateBackoff.blocked ? Math.ceil(this.gateBackoff.remaining / 1000) : 0,
        });
        return;
      }
      this.gateBackoff.reset();
      this.plugin.settings.passwordDay = dayStamp();
      await this.plugin.saveSettings();
      const data = await this.plugin.buildArchiveData();
      if (data.records.length) this.plugin.indexRecords(data.records);
      this.archiveData = data;
      this.postGateResult({ ok: true, records: data.records });
    } finally {
      this.gateBusy = false;
    }
  }

  private gateBackoff = new LoginBackoff();
  private postGateResult(result: { ok: boolean; records?: ArchiveData["records"]; remaining?: number }) {
    this.iframe?.contentWindow?.postMessage(
      { source: "rhine-host", type: "rhine-gate-result", result },
      "*",
    );
  }

  /**
   * 立即上锁（真机 bug 修复 2026-10-18）：设置页改密码时终端视图往往**已经开着**
   * （onOpen 不会重跑）。重挂为闸门前置态：iframe 重建、数据不下发、
   * 终端进场流程内嵌登录卡（authorized:false = 即便当天已通过也要重新验证）。
   */
  lockNow() {
    this.archiveData = null;
    // 无密码（设置页刚清掉）时不上锁：否则重挂的是空 iframe，画面会卡在闸门态。
    if (this.plugin.settings.password) {
      void this.mountTerminal(null, undefined, { authorized: false });
    }
  }

  /** 立即解锁（设置页清除密码后调用）：不关开视图就能恢复原流程。 */
  unlockNow() {
    this.archiveData = null;
    void this.unlockAndMount();
  }

  private renderLoading() {
    const box = this.contentEl.createDiv("rhine-boot-note");
    box.style.cssText =
      "display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:14px;letter-spacing:.2em;";
    box.setText("CONNECTING TO INTERNAL DATABASE …");
  }

  private renderEmpty(data: ArchiveData) {
    const box = this.contentEl.createDiv("rhine-empty-note");
    box.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--text-muted);";
    const title = box.createDiv();
    title.style.cssText = "font-size:16px;color:var(--text-normal);letter-spacing:.15em;";
    title.setText("DATABASE EMPTY");
    box.createDiv().setText(
      `在「${this.plugin.settings.folder || "Memory 库根目录"}」下未找到 Markdown 笔记（共扫描 ${data.columns.length} 个目录）。请在插件设置中调整档案目录。`,
    );
  }

  /**
   * 挂载终端 iframe。data = null 时为闸门前置挂载：不注入 RHINE_DATA，
   * 只注入 RHINE_GATE，终端自行完成「点击进入 → 登录卡 → 验证」流程，
   * 验证成功后经 rhine-gate-verify 回调拿到数据。
   */
  private async mountTerminal(
    data: ArchiveData | null,
    recover?: RhRecover,
    gate?: { authorized: boolean },
  ) {
    const [appJs, appCss] = await Promise.all([
      this.plugin.readPluginFile("app.js"),
      this.plugin.readPluginFile("app.css"),
    ]);
    if (!appJs || !appCss) {
      new Notice("莱茵档案终端：app.js / app.css 缺失，请重新构建插件。");
      return;
    }
    const baseUrl = this.plugin.assetBaseUrl();
    const inject = (value: unknown) =>
      JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    const recoverScript = recover
      ? `window.RHINE_RECOVER=${inject(recover)};`
      : "";
    // 个性化：展廊名自适应仓库名（Obsidian 官方 API，随仓库改名自动跟随）。
    const vaultName = this.plugin.app.vault.getName();
    const vaultScript = `window.RHINE_VAULT=${inject(vaultName)};`;
    // 闸门状态（2026-10-18 用户指导）：设了密码时终端进场流程**总是**先显示登录卡。
    //  authorized:true = 当天已通过 → 数据随本次挂载下发，卡片上点「登录」直接放行；
    //  authorized:false = 今天还没验证 → 数据绝不下发，验证通过后由 rhine-gate-result 回传。
    const gateScript = gate
      ? `window.RHINE_GATE={required:true,authorized:${gate.authorized}};`
      : "";
    // ⚠ 载荷本体（2026-10-18 真机「一直加载中」根因）：旧版注入 payload.data（数据本体），
    // 首版误写成 { base, data } 外壳 → iframe data.ts 读 RHINE_DATA.records 为 undefined，
    // 模块初始化即抛 TypeError → start() 永不执行，终端卡在「正在准备终端…」。
    const dataScript = data
      ? `window.RHINE_DATA=${inject(data)};`
      : "";
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${baseUrl}"><style>${appCss}</style></head><body><main id="viewport"><div id="stage"></div></main><script>window.RHINE_BASE_URL=${inject(baseUrl)};${dataScript}${gateScript}${vaultScript}${recoverScript}</script><script>${appJs}</script></body></html>`;

    this.contentEl.empty();
    // 重新挂载时旧的主页 iframe 已随 empty() 脱离 DOM，引用一并清掉，避免 showHome 复用死节点。
    if (this.homeListener) {
      window.removeEventListener("message", this.homeListener);
      this.homeListener = null;
    }
    this.homeIframe = null;
    this.homeCover = null;
    this.homeReady = false;
    this.homeLoad = null;
    this.homeGen += 1;
    this.homePending = false;
    this.homeIntroStarted = false;
    this.homeWarm = false;
    this.homeWarmDir = "";
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-downloads allow-modals",
    );
    // 允许终端 iframe 在视图打开时直接起播背景音乐（父级点击的激活可传递），
    // 避免必须点进登录卡才有声音。
    this.iframe.setAttribute("allow", "autoplay");
    this.iframe.setAttribute("allowfullscreen", "");
    this.iframe.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border:none;background:#0b0b09;display:block;visibility:hidden;";
    this.iframe.srcdoc = html;
    this.contentEl.appendChild(this.iframe);
    // 桥接随挂载注册（gated 首挂也需要：rhine-gate-verify 走这条通道）。
    this.registerHostBridge();
    // 外部指定的目录：等 iframe 文档载入（终端消息监听已注册）后再下发。
    this.iframe.addEventListener(
      "load",
      () => {
        if (this.iframe) this.iframe.style.visibility = "visible";
        this.flushPendingDir();
        // 告诉终端：开机动画播完先进主页，再由主页「进入」落到阵列。
        this.iframe?.contentWindow?.postMessage(
          { source: "rhine-host", type: "rhine-home-stage" },
          "*",
        );
      },
      { once: true },
    );
    window.setTimeout(() => this.flushPendingDir(), 1500);
    // 开机动画有二十多秒，主页文档在这段时间里提前载入并跑完自身入场；
    // 真正切到主页时只剩一次透明度过渡，不会在 2D 白场后先露一段白屏。
    void this.ensureHomeFrame();
  }

  /**
   * 重新扫描仓库并把新数据原地交给正在运行的终端（不重挂 iframe、不重放开机动画）。
   * 终端侧收到 rhine-refresh 后会 setData + applyDirectory，保持停留当前目录与选中项。
   * silent = true 用于 vault 事件触发的自动刷新（不打扰用户）。
   */
  async refreshTerminal(silent = true): Promise<void> {
    const data = await this.plugin.buildArchiveData();
    this.archiveData = data;
    this.plugin.indexRecords(data.records);
    if (!data.records.length) {
      this.renderEmpty(data);
      return;
    }
    const target = this.iframe?.contentWindow;
    if (!target) return;
    target.postMessage(
      { source: "rhine-host", type: "rhine-refresh", data: { records: data.records }, silent },
      "*",
    );
  }

  /**
   * 外部指定的目录（主页「进入」按钮 → obsidian://rhine?dir=…）。
   * iframe 尚未就绪时先挂起，等 iframe load 后再交给终端。
   */
  private pendingDir: string | null = null;

  /** 定位到某个大文件夹的档案阵列。 */
  gotoDirectory(dir: string) {
    this.pendingDir = dir;
    this.flushPendingDir();
  }

  private flushPendingDir() {
    const dir = this.pendingDir;
    if (dir === null) return;
    const target = this.iframe?.contentWindow;
    if (!target) return;
    this.pendingDir = null;
    target.postMessage({ source: "rhine-host", type: "rhine-goto-dir", dir }, "*");
  }

  /** 预加载主页 iframe（开机动画期间就在后台载入并跑完自身入场）。 */
  private ensureHomeFrame(): Promise<void> {
    if (this.homeIframe && this.homeReady) return Promise.resolve();
    if (this.homeLoad) return this.homeLoad;
    const gen = this.homeGen;
    this.homeLoad = (async () => {
      const raw = await this.plugin.readPluginFile("web/home-i/index.html");
      if (gen !== this.homeGen) return;
      const base = this.plugin.assetBaseUrl() + "web/home-i/";
      const html = raw
        ? raw.replace(
            /<head([^>]*)>/i,
            `<head$1><base href="${base}">${HOME_THEME_BRIDGE}<script>window.__RHINE_MANUAL_INTRO=true;</script>`,
          )
        : "<body style='background:#EFEAE0;color:#1D1A17;font:14px sans-serif;padding:24px'>主页资源缺失：请重新构建插件。</body>";
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
      // 预加载时保持 opacity:0 / pointer-events:none；真正交接的那一帧才从头播放入场。
      frame.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;border:none;background:#EFEAE0;visibility:hidden;opacity:0;transition:opacity .48s ease;pointer-events:none;z-index:2;";
      frame.srcdoc = html;
      const cover = document.createElement("div");
      cover.style.cssText =
        "position:absolute;inset:0;pointer-events:none;z-index:1;background:#F2EEE6;opacity:0;transition:opacity .16s ease;";
      this.homeCover = cover;
      await new Promise<void>((resolve) => {
        frame.addEventListener(
          "load",
          () => {
            if (gen !== this.homeGen) return;
            this.homeReady = true;
            frame.style.visibility = "visible";
            resolve();
          },
          { once: true },
        );
        if (gen !== this.homeGen) return;
        this.homeIframe = frame;
        this.contentEl.appendChild(frame);
        this.contentEl.appendChild(cover);
      });
    })();
    return this.homeLoad;
  }

  /** 片尾前只把主页文档准备好；入场动画留到真正交接的那一帧再从头播放。
   *  提前在隐藏层里跑掉会让用户看到「一张白纸停一会儿，然后主页突然完整出现」，
   *  既看不到设计好的入场，也像硬切。 */
  private async preloadHome() {
    await this.ensureHomeFrame();
  }

  /** 开机动画结束 → 把画面交给主页：从这里从头播放主页设计好的入场动画。
   *  终端停在片尾白场，主页第一帧也是同一张纸白幕，交接时颜色连续。
   *  不再提前在隐藏层跑掉入场，也不再等 460ms——否则用户看到的是「白纸停住 → 主页突然完整」。 */
  private async showHome() {
    this.homePending = true;
    if (this.iframe) {
      this.iframe.contentWindow?.postMessage({ source: "rhine-host", type: "rhine-pause" }, "*");
    }
    await this.ensureHomeFrame();
    if (!this.homePending || !this.homeIframe) return;
    const frame = this.homeIframe;
    // 先把纸色遮片盖在终端上，再让主页可见：主页 iframe 从 hidden→visible 的
    // 首帧合成需要一两帧，否则会先闪出终端开机动画的最后一帧（WELCOME 画面）。
    const cover = this.homeCover;
    if (cover) {
      cover.style.transition = "none";
      cover.style.opacity = "1";
    }
    frame.style.visibility = "visible";
    frame.style.pointerEvents = "auto";
    if (this.iframe) this.iframe.style.display = "block";
    // 先同步建好入场（白幕 + 各段 WAAPI），再让主页可见：第一帧就是纸白幕，
    // 和下层终端的片尾白场同色，不会闪一帧默认页面。
    let started = 0;
    try {
      started =
        (frame.contentWindow as Window & { __introRun?: () => number })?.__introRun?.() ?? 0;
      this.homeIntroStarted = started > 0;
    } catch {
      this.homeIntroStarted = false;
    }
    frame.style.transition = "none";
    frame.style.opacity = "1";
    // 等主页首帧进入合成后再撤掉纸色遮片（同色淡出，不会露终端）。
    if (cover) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this.homeCover !== cover) return;
        cover.style.transition = "opacity .16s ease";
        cover.style.opacity = "0";
      }));
    }
    // 主页已经盖住终端：在入场动画结束后再把终端点亮、预渲染档案首帧。
    // 预热会占用同一渲染主线程约 0.6s，放在入场期间会把动画卡住，所以等到
    // 文字落定（约 3s）之后再跑；此时用户通常还在看主页，不会察觉。
    this.homeWarm = false;
    this.homeWarmDir = "";
    let warmDir = "";
    try {
      const fn = (frame.contentWindow as Window & { __rhineHomeDir?: () => string } | null)
        ?.__rhineHomeDir;
      if (typeof fn === "function") warmDir = String(fn() || "");
    } catch {
      /* 主页桥未就绪时按根目录预热 */
    }
    const warmDelay = started > 0 ? 3000 : 180;
    window.setTimeout(() => {
      if (!this.homePending) return;
      this.iframe?.contentWindow?.postMessage(
        { source: "rhine-host", type: "rhine-warm-archive", dir: warmDir },
        "*",
      );
    }, warmDelay);
  }

  /** 主页「进入」→ 先让主页把自己的设计退场播完，再露出下面已画好的终端阵列。 */
  private exitHomeWithAnimation() {
    if (!this.homePending) return;
    this.homePending = false;
    const frame = this.homeIframe;
    const startedAt = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frame) {
        frame.style.clipPath = "";
        frame.style.transition = "";
      }
      this.finishShowTerminal();
    };
    // 兜底：主页脚本没有可反向播放的入场动画（减少动态效果、跳过开机、资源未就绪）时，
    // 在 iframe 元素上跑同一套「CRT 断电」收拢，仍然不会硬切/露白。
    const hostCrtClose = () => {
      if (finished || !frame) return finish();
      frame.style.willChange = "clip-path";
      frame.style.clipPath = "inset(0% 0% 0% 0%)";
      void frame.offsetWidth;
      frame.style.transition = "clip-path .40s cubic-bezier(.4,0,.2,1)";
      frame.style.clipPath = "inset(48.6% 0% 48.6% 0%)";
      // 与主页 __introOut 同一节奏：400 + 350 = 750ms，两段之间没有空等。
      window.setTimeout(() => {
        if (finished || !frame) return finish();
        frame.style.transition = "clip-path .35s cubic-bezier(.4,0,.2,1)";
        frame.style.clipPath = "inset(49.9% 50% 49.9% 50%)";
        window.setTimeout(finish, 350);
      }, 400);
    };
    // 不做 iframe opacity 淡出：那只是把整层变透明，用户看到的还是「淡出+跳变」。
    // 真正用主页自己的转场：iframe 元素底色置透明，页面内 __introOut 播
    // 屏幕板/展台/字体收回，阵列从收拢的缝里露出来，最后才收起 iframe。
    if (frame) {
      frame.style.background = "transparent";
      frame.style.pointerEvents = "none";
    }
    try {
      const out = (
        frame?.contentWindow as (Window & { __introOut?: () => Promise<void> }) | null
      )?.__introOut?.();
      if (out && typeof out.then === "function") {
        out.then(
          () => {
            // 正常内层转场约 750ms；若瞬间结束说明没有可播动画，改用宿主兜底。
            if (performance.now() - startedAt < 150) hostCrtClose();
            else finish();
          },
          hostCrtClose,
        );
      } else {
        hostCrtClose();
      }
    } catch {
      hostCrtClose();
    }
  }

  private finishShowTerminal() {
    if (this.homeIframe) {
      this.homeIframe.style.opacity = "0";
      this.homeIframe.style.pointerEvents = "none";
    }
    if (this.iframe) {
      this.iframe.style.display = "block";
      this.iframe.style.visibility = "visible";
    }
  }

  private registerHostBridge() {
    // mountTerminal 可能多次调用（rebuild/上锁重挂）：先摘旧监听再挂新的，防重复。
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }
    this.messageListener = (event: MessageEvent) => {
      const data = event.data as
        | {
            source?: string;
            type?: string;
            path?: string;
            message?: string;
            mode?: string;
            index?: number;
            dir?: string;
            password?: string;
          }
        | null;
      if (!data || data.source !== "rhine-terminal") return;
      if (event.source !== this.iframe?.contentWindow) return;
      if (data.type === "rhine-gate-verify" && typeof data.password === "string") {
        void this.handleGateVerify(String(data.password));
      } else if (data.type === "rhine-home-pre") {
        // 片尾白场前只把主页文档准备好；入场留到交接帧再播，避免隐藏在后台跑完。
        void this.preloadHome();
      } else if (data.type === "rhine-home-ready") {
        void this.showHome();
      } else if (data.type === "rhine-warm-ready") {
        // 主页遮住终端期间已经预热出档案阵列首帧：记下目录，点击「进入」时若目录
        // 一致即可立刻开始 CRT，不必再等 iframe 内约 300ms 的 message/rAF 节流。
        this.homeWarm = true;
        this.homeWarmDir = typeof data.dir === "string" ? data.dir : "";
      } else if (data.type === "rhine-enter-ready") {
        // 终端已经切到目标目录并画出第一帧 → 此时才让主页播退场并淡出，避免露白。
        this.exitHomeWithAnimation();
      } else if (data.type === "rhine-reveal" && typeof data.path === "string") {
        const action = this.plugin.revealPath(data.path);
        this.iframe?.contentWindow?.postMessage({ source: "rhine-host", type: "rhine-reveal-result", action }, "*");
      } else if (data.type === "rhine-rebuild") {
        // 终端侧检测到图形上下文无法恢复 → 原样重挂，并让它回到出事前的目录/档案。
        if (!this.archiveData) return;
        const recover = {
          mode: typeof data.mode === "string" ? data.mode : "archive",
          index: typeof data.index === "number" ? data.index : 0,
          dir: typeof data.dir === "string" ? data.dir : "",
        };
        new Notice("莱茵档案终端：显示资源已回收，正在重构画面…", 4000);
        void this.mountTerminal(
          this.archiveData,
          recover,
          // 能走到 rebuild 说明本次会话已解锁 → 卡片照常显示但可直接点登录过去。
          this.plugin.settings.password ? { authorized: true } : undefined,
        );
      } else if (data.type === "rhine-error" && typeof data.message === "string") {
        if (this.errorNotice) this.errorNotice.hide();
        this.errorNotice = new Notice(`[莱茵终端] ${data.message}`, 12000);
      } else if (data.type === "rhine-open" && typeof data.path === "string") {
        const path = data.path;
        this.plugin.openDoc(path).catch(() => {
          new Notice(`无法打开：${path}`);
        });
      }
    };
    window.addEventListener("message", this.messageListener);
    if (this.homeListener) window.removeEventListener("message", this.homeListener);
    this.homeListener = (event: MessageEvent) => {
      const d = event.data as { source?: string; type?: string; dir?: string } | null;
      if (!d || d.source !== "rhine-home") return;
      if (event.source !== this.homeIframe?.contentWindow) return;
      if (d.type === "enter") {
        const dir = typeof d.dir === "string" ? d.dir : "";
        // 先让下层终端切到目标目录并渲染出第一帧，再淡出主页；顺序反过来会在
        // 主页退场与阵列首帧之间露出终端片尾的白场。
        this.iframe?.contentWindow?.postMessage(
          { source: "rhine-host", type: "rhine-enter-dir", dir },
          "*",
        );
        this.iframe?.contentWindow?.postMessage(
          { source: "rhine-host", type: "rhine-resume" },
          "*",
        );
        // 预热已画好同一目录的阵列：点击即刻开始 CRT，终端底层已有现成一帧。
        if (this.homeWarm && (dir || "") === this.homeWarmDir) {
          this.exitHomeWithAnimation();
          return;
        }
        // 终端切目录可能同步卡住主线程，固定计时会被一起推迟；以它的首帧回执
        // rhine-enter-ready 为准，另留较长超时兜底（正常不会走到）。
        window.setTimeout(() => {
          if (this.homePending) this.exitHomeWithAnimation();
        }, 8000);
      }
    };
    window.addEventListener("message", this.homeListener);
    this.leafChangeListener = (leaf) => {
      const active = leaf?.view === this;
      this.iframe?.contentWindow?.postMessage(
        { source: "rhine-host", type: active ? "rhine-resume" : "rhine-pause" },
        "*",
      );
    };
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.leafChangeListener),
    );
  }

  async onClose() {
    this.untagHostChrome();
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }
    if (this.homeListener) {
      window.removeEventListener("message", this.homeListener);
      this.homeListener = null;
    }
    this.homeIframe?.remove();
    this.homeIframe = null;
    this.iframe?.remove();
    this.iframe = null;
  }
}

export class RhineHomeView extends ItemView {
  private plugin: RhineArchivePlugin;
  private iframe: HTMLIFrameElement | null = null;
  private onMessage: ((event: MessageEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RhineArchivePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType() { return VIEW_TYPE_RHINE_HOME; }
  getDisplayText() { return "莱茵主页"; }
  getIcon() { return "home"; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("rhine-home-content");
    this.contentEl.style.padding = "0";
    this.contentEl.style.overflow = "hidden";
    this.contentEl.style.position = "relative";
    const raw = await this.plugin.readPluginFile("web/home-i/index.html");
    const base = this.plugin.assetBaseUrl() + "web/home-i/";
    const html = raw
      ? raw.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">${HOME_THEME_BRIDGE}`)
      : "<body style=\"background:#EFEAE0;color:#1D1A17;font:14px sans-serif;padding:24px\">\u4e3b\u9875\u8d44\u6e90\u7f3a\u5931\uff1a\u8bf7\u91cd\u65b0\u6784\u5efa\u63d2\u4ef6\u3002</body>";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#EFEAE0";
    iframe.srcdoc = html;
    this.iframe = iframe;
    this.contentEl.appendChild(iframe);
    this.iframe = iframe;
    this.contentEl.appendChild(iframe);
    this.onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; dir?: string } | null;
      if (!data || data.source !== "rhine-home") return;
      if (data.type === "enter") {
        void this.plugin.openTerminalAt(typeof data.dir === "string" ? data.dir : "");
      }
    };
    window.addEventListener("message", this.onMessage);
  }

  async onClose() {
    if (this.onMessage) window.removeEventListener("message", this.onMessage);
    this.onMessage = null;
    this.iframe = null;
  }
}

export class RhineArchivePlugin extends Plugin {
  settings: RhineSettings = { ...DEFAULT_SETTINGS };

  /** path → 档案记录（编号/分类/状态），供文档视图呈现 HUD。 */
  private recordIndex = new Map<string, DocRecord>();
  /** 当前套着终端皮肤的那个笔记标签页。 */
  private skinnedLeaf: WorkspaceLeaf | null = null;
  private lastRevealedPath = "";
  /** vault 事件触发的刷新防抖计时器（批量操作时只重建一次）。 */
  private refreshTimer: number | null = null;

  recordFor(path: string) {
    return this.recordIndex.get(path);
  }

  /** 打开终端风格的档案文档视图；同一 leaf 复用（翻档案体验）。 */
  async openDoc(path: string, leaf?: WorkspaceLeaf) {
    const target =
      leaf ?? this.app.workspace.getLeaf("tab") ?? this.app.workspace.getLeaf(true);
    if (!target) {
      this.openNative(path);
      return;
    }
    await target.setViewState({
      type: VIEW_TYPE_RHINE_DOC,
      active: true,
      state: { path },
    });
    this.app.workspace.revealLeaf(target);
  }

  /** 兜底：用 Obsidian 原生界面打开（不套皮肤）。 */
  openNative(path: string) {
    this.app.workspace.openLinkText(path, "", true).catch(() => {
      new Notice(`无法打开：${path}`);
    });
  }

  /**
   * 打开「可编辑 + 终端皮肤」的原生视图：
   * 用 Obsidian 自带的编辑器（可编辑），只给这个标签页挂 .rhine-skin 作用域样式，
   * 其它标签页与全局主题不受影响。
   */
  async openEditable(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${path}`);
      return;
    }
    const leaf =
      this.app.workspace.getLeaf("tab") ?? this.app.workspace.getLeaf(true);
    await leaf.openFile(file, { active: true });
    this.skinLeaf(leaf);
    // Obsidian 可能在打开后重建视图/重排标签页，稍后各复核一次，确保皮肤不掉。
    window.setTimeout(() => this.reconcileSkin(), 260);
    window.setTimeout(() => this.reconcileSkin(), 1200);
    this.app.workspace.revealLeaf(leaf);
  }

  /** 给标签页套皮肤；移除此前套过的其它标签页，保持只有当前档案页是终端皮肤。 */
  private skinLeaf(leaf: WorkspaceLeaf) {
    const el = leaf.view?.containerEl;
    if (!el) return;
    for (const other of this.app.workspace.getLeavesOfType("markdown")) {
      if (other !== leaf) {
        other.view.containerEl.removeClass("rhine-skin");
        (other.view.containerEl as HTMLElement).closest(".workspace-tabs")?.classList.remove("rhine-skin-tabs");
      }
    }
    el.addClass("rhine-skin");
    el.setAttr("data-rhine-skin", "1");
    (el as HTMLElement).closest(".workspace-tabs")?.classList.add("rhine-skin-tabs");
    this.skinnedLeaf = leaf;
  }

  /** 给所有已打开的莱茵终端标签组挂稳定类（插件热重载时视图不会重跑 onOpen，必须从插件层补）。 */
  private syncArchiveTabChrome() {
    const wanted = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RHINE)) {
      const tabs = (leaf.view?.containerEl as HTMLElement | undefined)?.closest(".workspace-tabs") as HTMLElement | null;
      if (tabs) wanted.add(tabs);
    }
    document.querySelectorAll(".workspace-tabs.rhine-archive-tabs").forEach((node) => {
      if (!wanted.has(node as HTMLElement)) node.classList.remove("rhine-archive-tabs");
    });
    wanted.forEach((tabs) => tabs.classList.add("rhine-archive-tabs"));
    // 兜底：Obsidian 的标签栏 DOM 偶尔会被重建/不在预期层级，给 body 挂一个「终端视图激活」标记，
    // 让 CSS 不依赖具体祖先结构也能把标签头刷成纸色（含左侧栏那块）。
    const active = this.app.workspace.getActiveViewOfType(RhineArchiveView);
    document.body.classList.toggle("rhine-archive-active", !!active);
  }

  /** 皮肤自愈：视图被重建、标签重排后把类名补回来（只在确实丢了时才动 DOM）。 */
  private reconcileSkin() {
    const leaf = this.skinnedLeaf;
    if (!leaf) return;
    const view = leaf.view;
    if (!view || view.getViewType() !== "markdown") {
      this.skinnedLeaf = null;
      return;
    }
    for (const other of this.app.workspace.getLeavesOfType("markdown")) {
      if (other !== leaf) {
        other.view.containerEl.removeClass("rhine-skin");
        (other.view.containerEl as HTMLElement).closest(".workspace-tabs")?.classList.remove("rhine-skin-tabs");
      }
    }
    if (!view.containerEl.classList.contains("rhine-skin")) {
      view.containerEl.addClass("rhine-skin");
      view.containerEl.setAttr("data-rhine-skin", "1");
    }
    (view.containerEl as HTMLElement).closest(".workspace-tabs")?.classList.add("rhine-skin-tabs");
  }

  /** 命令：手动套用／取消当前笔记标签页的终端皮肤（也用于快速自检）。 */
  private toggleSkinOnActiveNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("当前标签页不是笔记页。");
      return;
    }
    if (view.containerEl.classList.contains("rhine-skin")) {
      view.containerEl.removeClass("rhine-skin");
      (view.containerEl as HTMLElement).closest(".workspace-tabs")?.classList.remove("rhine-skin-tabs");
      if (this.skinnedLeaf === view.leaf) this.skinnedLeaf = null;
      new Notice("已取消终端皮肤。");
      return;
    }
    this.skinLeaf(view.leaf);
    new Notice("已套用终端皮肤（仅此标签页）。");
  }

  openTerminal() {
    void this.activateView();
  }

  /** 打开终端并定位到指定目录的档案阵列（供 obsidian://rhine?dir= 调用）。 */
  async openTerminalAt(dir: string) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RHINE)[0];
    const view = leaf?.view;
    if (view instanceof RhineArchiveView) {
      view.gotoDirectory(dir);
      return;
    }
    new Notice("莱茵档案终端：视图未就绪，请重试。", 4000);
  }

  /** 在文件列表中定位源文件；同一文件再次调用则收起侧栏。 */
  revealPath(path: string): "revealed" | "collapsed" {
    const file = this.app.vault.getAbstractFileByPath(path);
    const sidebar = this.app.workspace.leftSplit;
    if (this.lastRevealedPath === path && sidebar && !sidebar.collapsed) {
      sidebar.collapse();
      this.lastRevealedPath = "";
      return "collapsed";
    }
    this.lastRevealedPath = path;
    if (sidebar?.collapsed) sidebar.expand();
    const explorer = (
      this.app as unknown as {
        internalPlugins?: {
          getPluginById?: (id: string) => {
            instance?: { revealInFolder?: (file: unknown) => void };
          } | null;
        };
      }
    ).internalPlugins?.getPluginById?.("file-explorer");
    if (file && explorer?.instance?.revealInFolder) {
      explorer.instance.revealInFolder(file);
    } else {
      new Notice(`源文件：${path}`);
    }
    return "revealed";
  }

  /** 缓存扫描结果，供文档视图读取编号 / 分类 / 状态。 */
  indexRecords(records: DocRecord[]) {
    for (const record of records) {
      this.recordIndex.set(record.path, record);
    }
  }

  /** 该路径是否会进入档案库（与 buildArchiveData 的过滤规则保持一致）。 */
  private isArchivedPath(path: string): boolean {
    if (!path) return false;
    const root = this.settings.folder.trim().replace(/[\\/]+$/, "");
    if (root && !(path === root || path.startsWith(root + "/"))) return false;
    if (path.startsWith(".obsidian") || path.startsWith(".trash")) return false;
    if (path.startsWith("Agents/") || path === "Agents") return false;
    return !path.split("/").some((segment) => segment.startsWith("."));
  }

  /** 防抖：vault 批量变更（同步、批量改名等）时只重建一次。 */
  scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAllTerminals(true);
    }, 1500);
  }

  /** 重建数据并原地刷新所有已打开的终端视图。 */
  async refreshAllTerminals(silent: boolean): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RHINE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof RhineArchiveView) await view.refreshTerminal(silent);
    }
  }

  async onload() {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_RHINE,
      (leaf) => new RhineArchiveView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_RHINE_DOC,
      (leaf) => new RhineDocView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_RHINE_HOME,
      (leaf) => new RhineHomeView(leaf, this),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.reconcileSkin();
        this.syncArchiveTabChrome();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.reconcileSkin();
        this.syncArchiveTabChrome();
      }),
    );
    // 插件启动时补一次（热重载/重启后已打开的终端视图不会重跑 onOpen）。
    window.setTimeout(() => this.syncArchiveTabChrome(), 0);
    window.setTimeout(() => this.syncArchiveTabChrome(), 600);
    this.addCommand({
      id: "toggle-terminal-skin",
      name: "套用／取消终端皮肤（当前笔记标签页）",
      callback: () => this.toggleSkinOnActiveNote(),
    });
    this.addRibbonIcon("box", "莱茵档案终端", () => {
      void this.activateView();
    });
    this.addCommand({
      id: "open-rhine-terminal",
      name: "打开莱茵档案终端",
      callback: () => {
        void this.activateView();
      },
    });
    this.addCommand({
      id: "refresh-terminal-data",
      name: "刷新终端数据（重新扫描仓库）",
      callback: () => {
        void this.refreshAllTerminals(false);
      },
    });
    // 仓库结构变化 → 自动重建（1.5s 防抖，只处理会进档案库的路径）
    const onVaultChange = (file: TAbstractFile) => {
      if (!this.isArchivedPath(file.path)) return;
      this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
    this.addSettingTab(new RhineSettingTab(this.app, this));
    // 自定义协议：主页「进入」按钮 → obsidian://rhine?dir=<大文件夹>
    // 打开终端并直接落到该目录的档案阵列。
    try {
      (
        this as unknown as {
          registerObsidianProtocolHandler?: (
            action: string,
            handler: (params: Record<string, unknown>) => unknown,
          ) => void;
        }
      ).registerObsidianProtocolHandler?.("rhine", (params) => {
        const dir = typeof params?.dir === "string" ? params.dir : "";
        void this.openTerminalAt(dir);
        return true;
      });
    } catch (error) {
      console.warn("[莱茵档案终端] 注册 rhine:// 协议失败", error);
    }
  }

  onunload() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    void this.app.workspace.detachLeavesOfType(VIEW_TYPE_RHINE_DOC);
    void this.app.workspace.detachLeavesOfType(VIEW_TYPE_RHINE);
    void this.app.workspace.detachLeavesOfType(VIEW_TYPE_RHINE_HOME);
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateHome() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_RHINE_HOME)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf =
      workspace.getLeaf(true) ?? workspace.getLeftLeaf(false) ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_RHINE_HOME, active: true });
    workspace.revealLeaf(leaf);
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_RHINE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf =
      workspace.getLeaf(true) ?? workspace.getLeftLeaf(false) ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_RHINE, active: true });
    workspace.revealLeaf(leaf);
  }

  assetBaseUrl(): string {
    const adapter = this.app.vault.adapter as {
      getResourcePath?: (path: string) => string;
      getBasePath?: () => string;
    };
    if (typeof adapter.getResourcePath === "function") {
      const url = adapter.getResourcePath(`${PLUGIN_DIR}/app.js`);
      return url.replace(/app\.js(\?.*)?$/, "");
    }
    const base = adapter.getBasePath?.() ?? "";
    return `app://local/${encodeURI(`${base}/${PLUGIN_DIR}`.replace(/\\/g, "/"))}/`;
  }

  async readPluginFile(name: string): Promise<string | null> {
    try {
      const cfg = (this.app.vault as unknown as { configDir?: string }).configDir ?? ".obsidian";
      return await this.app.vault.adapter.read(`${cfg}/plugins/rhine-archive-terminal/${name}`);
    } catch {
      return null;
    }
  }

  async buildArchiveData(): Promise<ArchiveData> {
    const root = this.settings.folder.trim().replace(/[\\/]+$/, "");
    const markdown = this.app.vault.getMarkdownFiles();
    const files = markdown.filter((f) => {
      if (root) {
        if (!f.path.startsWith(root + "/")) return false;
      } else if (f.path.includes("/")) {
        // vault root mode: everything is allowed; category = first segment
      }
      if (f.path.startsWith(".obsidian") || f.path.startsWith(".trash")) return false;
      if (f.path.startsWith("Agents/") || f.path === "Agents") return false;
      const segments = f.path.split("/");
      if (segments.some((s) => s.startsWith("."))) return false;
      return true;
    });

    const groups = new Map<string, TFile[]>();
    for (const file of files) {
      let rel = file.path;
      if (root && file.path.startsWith(root + "/")) {
        rel = file.path.slice(root.length + 1);
      }
      const segments = rel.split("/");
      // 档案列 = 完整父目录路径（一级/二级…），让文件夹层级直接体现在终端阵列里
      const category = segments.length > 1 ? segments.slice(0, -1).join(" / ") : "根目录档案";
      const bucket = groups.get(category);
      if (bucket) bucket.push(file);
      else groups.set(category, [file]);
    }

    // 3D 阵列最多 9 列：按文件数取前 8 列，其余合并为「其它档案」
    const sorted = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN"),
    );
    let columns: string[];
    const merged = new Map<string, TFile[]>();
    if (sorted.length > MAX_COLUMNS) {
      const head = sorted.slice(0, MAX_COLUMNS - 1);
      const tail = sorted.slice(MAX_COLUMNS - 1);
      columns = [...head.map(([c]) => c), "其它档案"];
      for (const [category, list] of head) merged.set(category, list);
      merged.set(
        "其它档案",
        tail.flatMap(([, list]) => list),
      );
    } else {
      columns = sorted.map(([c]) => c);
      for (const [category, list] of sorted) merged.set(category, list);
    }
    columns.sort((a, b) => a.localeCompare(b, "zh-CN"));

    const records: ArchiveRecordData[] = [];
    let seq = 1;
    for (const column of columns) {
      const list = (merged.get(column) ?? []).sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
      for (const file of list) {
        records.push(await this.toRecord(file, column, root, seq++));
      }
    }
    return { records, categories: columns, columns };
  }

  private async toRecord(file: TFile, category: string, root: string, seq: number): Promise<ArchiveRecordData> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    // 未处理的 Templater <% ... %> 原文绝不上屏（与 test-server.mjs 同步）；剥空则回落原值。
    const stripTpl = (s: string) => s.replace(/<%[\s\S]*?%>/g, " ").replace(/\s+/g, " ").trim();
    let body = "";
    try {
      const raw = await this.app.vault.cachedRead(file);
      const end = cache?.frontmatterPosition?.end?.offset;
      body = typeof end === "number" ? raw.slice(end) : raw;
    } catch {
      body = "";
    }

    const rel = root && file.path.startsWith(root + "/") ? file.path.slice(root.length + 1) : file.path;
    const segments = rel.split("/");
    const department = segments.length > 1 ? segments.slice(0, -1).join(" / ") : "MEMORY ROOT";

    const title = stripTpl(file.basename) || file.basename;
    const h1 = cache?.headings?.find((h) => h.level === 1)?.heading;
    const rawEn = h1 && h1.trim() && h1.trim() !== file.basename ? h1.trim() : file.basename;
    const en = stripTpl(rawEn) || rawEn;

    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const value = fm[key];
        if (typeof value === "string" && value.trim()) return stripTpl(value) || value.trim();
      }
      return "";
    };

    let abstract = pick("描述", "摘要", "summary", "description");
    if (!abstract) {
      const lines = body.split(/\r?\n/);
      let collecting = false;
      const parts: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (collecting) break;
          continue;
        }
        if (/^(#|!\[\[|\[\[|>|\|```|`{3,})/.test(trimmed)) {
          if (collecting) break;
          continue;
        }
        parts.push(stripTpl(stripMarkdown(trimmed)) || stripMarkdown(trimmed));
        collecting = true;
        if (parts.join(" ").length > 180) break;
      }
      abstract = parts.join(" ").slice(0, 220);
    }

    const findings: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!/^[-*+]\s+/.test(trimmed) && !/^\d+[.)]\s+/.test(trimmed)) continue;
      const text = stripTpl(stripMarkdown(trimmed)) || stripMarkdown(trimmed);
      if (text && !findings.includes(text)) findings.push(text);
      if (findings.length >= 5) break;
    }

    let date = pick("日期", "date");
    if (!date) {
      const mtime = new Date(file.stat.mtime);
      date = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}-${String(mtime.getDate()).padStart(2, "0")}`;
    }
    // 标签：frontmatter 标签/tags（字符串或数组）
    const tagsRaw = fm["标签"] ?? fm["tags"] ?? fm["tag"];
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map((t: unknown) => String(t).replace(/^#/, "")).join(" · ")
      : typeof tagsRaw === "string" && tagsRaw.trim()
        ? stripTpl(tagsRaw.replace(/^\[|\]$/g, "")).split(/[,，\s]+/).filter(Boolean).map((t) => t.replace(/^#/, "")).join(" · ")
        : "";
    // 状态：frontmatter 状态/status，缺省显示已归档
    const status = pick("状态", "status") || "已归档 · 可读取";

    const dirSegments = segments.slice(0, -1);
    const dir = dirSegments.join("/");

    // 首图（详情卡封面带，用户 2026-10-14 裁定「正式笔记里如果插入了图片也在对应位置显示」）：
    // 扫嵌入与链接缓存，只收图片扩展名，经 metadataCache 解析（别名/最短路径）后取 vault
    // 资源完整 URL；外链、解析不到（未入库附件）一律忽略——宁缺勿错。
    // ⚠ CachedMetadata 的字段是 `embeds` / `links`（embeds = `![[x]]` 与 `![](x)`，
    // links = `[[x]]`）；不存在 embedLinks/imageLinks —— 2026-10-16 真机「什么也没有」
    // 即误用这两个不存在的字段导致候选恒空（test-server 用正则独立实现，故未暴露）。
    // 首图（详情卡封面带 + 墙书脊缩略图，用户 2026-10-14 裁定「正式笔记里如果插入了
    // 图片也在对应位置显示」）：
    // ⚠ 两个坑：① CachedMetadata 的字段是 `embeds` / `links`（embeds = `![[x]]` 与
    // `![](x)`），**不存在** embedLinks/imageLinks —— 误用会让候选恒空（2026-10-16 真机
    // 「什么也没有」的根因，test-server 用正则独立实现故未暴露）。② 终端在 sandbox iframe
    // 里，app://local 与 iframe 不同源，直接给 URL 会把图 drawImage 进 canvas 后**污染
    // 画布**（WebGL 上传抛 SecurityError 打断渲染）。故不走 URL，改由宿主 readBinary
    // 取字节 → 内存 Blob（无 CORS 概念）→ 缩到 640px → data URL。
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
    const linkCandidates: string[] = [];
    for (const l of cache?.embeds ?? []) linkCandidates.push(l.link);
    for (const l of cache?.links ?? []) linkCandidates.push(l.link);
    // 兜底：元数据缓存可能还没索引到该笔记（新写入/未打开过），直接扫正文原文。
    for (const m of body.matchAll(/!\[\[([^\]]+?)\]\]/g)) linkCandidates.push(m[1]);
    for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) linkCandidates.push(decodeURIComponent(m[1]));
    let imageUrl: string | undefined;
    const seen = new Set<string>();
    for (const link of linkCandidates) {
      const clean = link.split("#")[0].split("|")[0].trim();
      if (!clean || !IMAGE_EXT.test(clean) || seen.has(clean)) continue;
      seen.add(clean);
      const dest = this.app.metadataCache.getFirstLinkpathDest(clean, file.path);
      if (!dest) continue;
      imageUrl = await this.imageDataUrl(dest);
      if (imageUrl) break;
    }
    // 真机自检：笔记里明明有图片嵌入却没解析出首图时留下可诊断线索（仅控制台，不打扰用户）。
    if (!imageUrl && linkCandidates.length > 0) {
      console.warn(
        `[莱茵档案终端] 未解析出首图：${file.path} 候选=${JSON.stringify(linkCandidates)}`,
      );
    }

    return {
      id: `X-${String(seq).padStart(3, "0")}`,
      title,
      en,
      department,
      category,
      date,
      lead: tags,
      clearance: status,
      abstract,
      findings,
      source: "",
      path: file.path,
      dir,
      imageUrl,
    };
  }

  /** path → data URL 缓存（同一张图被多篇笔记引用时只解码一次；失败也缓存 null 避免反复重试）。 */
  private imageDataCache = new Map<string, Promise<string | undefined>>();
  private imageDataUrl(file: TFile): Promise<string | undefined> {
    let pending = this.imageDataCache.get(file.path);
    if (!pending) {
      pending = this.buildImageDataUrl(file);
      this.imageDataCache.set(file.path, pending);
    }
    return pending;
  }
  /**
   * 宿主侧把 vault 图片解码并缩到 640px 长边，交付内存 data URL。
   * 为什么不直接把 getResourcePath 的 URL 给终端：终端跑在 sandbox iframe 里，
   * app://local 与 iframe 不同源 —— 图会被 drawImage 进画布后污染，WebGL 上传抛
   * SecurityError 打断渲染。宿主 readBinary 拿到的是字节，走 Blob 无 CORS 概念，
   * 转成 data URL 后终端侧等同同源，且省掉一次磁盘协议请求。
   */
  private async buildImageDataUrl(file: TFile): Promise<string | undefined> {
    try {
      const buffer = await this.app.vault.readBinary(file);
      const bitmap = await createImageBitmap(new Blob([buffer]));
      const maxEdge = 640;
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return undefined;
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      // 有真实透明像素才用 PNG：照片类 JPEG 小一个数量级（data URL 会内联进 srcdoc）。
      const alpha = ctx.getImageData(0, 0, w, h).data;
      let transparent = false;
      for (let i = 3; i < alpha.length; i += 4) {
        if (alpha[i] < 250) {
          transparent = true;
          break;
        }
      }
      return canvas.toDataURL(transparent ? "image/png" : "image/jpeg", 0.85);
    } catch {
      return undefined;
    }
  }
}

class RhineSettingTab extends PluginSettingTab {
  private plugin: RhineArchivePlugin;

  constructor(app: App, plugin: RhineArchivePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "莱茵档案终端" });

    new Setting(containerEl)
      .setName("档案目录")
      .setDesc("要展示的仓库内文件夹（留空 = 整个 Memory 库；一级子文件夹 = 档案列，最多 9 列）。修改后自动刷新；也可用命令「刷新终端数据」手动重建。")
      .addText((text) =>
        text
          .setPlaceholder("例如：记忆层")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim();
            await this.plugin.saveSettings();
            this.plugin.scheduleRefresh();
          }),
      );

    // —— 访问密码（门禁式）：打开终端前先验证，当天首次需输入 ——
    const gate = new Setting(containerEl)
      .setName("访问密码")
      .setDesc(
        this.plugin.settings.password
          ? "已启用。打开终端需先验证密码；当天首次输入后，当天再打开只播一段「已授权」动画。"
          : "未设置。设置后，打开终端会先要求输入密码（门禁式：验证前不会读取任何档案内容）。",
      );
    if (this.plugin.settings.password) {
      gate.addButton((button) =>
        button.setButtonText("修改密码").onClick(() => this.promptPassword(true)),
      );
      gate.addButton((button) =>
        button
          .setButtonText("清除密码")
          .setWarning()
          .onClick(async () => {
            // 免旧密码清除：与 2026-10-14 裁定一致（忘记密码可在设置重置）。
            // 边界如实说明：能进设置的人本来就能翻本地文件，这扇门防的是随手窥探。
            this.plugin.settings.password = undefined;
            this.plugin.settings.passwordDay = undefined;
            try {
              await this.plugin.saveSettings();
            } catch (error) {
              console.error("[莱茵档案终端] 清除密码失败", error);
              new Notice(`清除密码失败——${String(error).slice(0, 80)}`);
              return;
            }
            // 立即解锁停在闸门上的视图（不必关开标签）
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RHINE)) {
              if (leaf.view instanceof RhineArchiveView) leaf.view.unlockNow();
            }
            new Notice("莱茵档案终端：访问密码已清除。");
            this.display();
          }),
      );
    } else {
      gate.addButton((button) =>
        button
          .setButtonText("设置密码")
          .setCta()
          .onClick(() => this.promptPassword(false)),
      );
    }
  }

  /** 设置/修改密码的输入框（不弹 Obsidian 的模糊框，避免遮蔽上下文）。 */
  private promptPassword(changing: boolean) {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: changing ? "修改访问密码" : "设置访问密码" });
    containerEl.createEl("p", {
      text: "密码经 PBKDF2-SHA256（30 万次迭代 + 随机盐）派生后保存在插件数据里；忘记可在设置中直接清除，无需旧密码。",
      cls: "setting-item-description",
    });
    let first = "";
    let second = "";
    new Setting(containerEl)
      .setName("新密码")
      .setDesc("至少 6 位。此密码只防随手翻看，不加密笔记本身。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("输入新密码").onChange((value) => (first = value));
      });
    new Setting(containerEl)
      .setName("再输一次")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("确认密码").onChange((value) => (second = value));
      });
    new Setting(containerEl)
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(async () => {
          if (first.length < 6) {
            new Notice("密码至少 6 位。");
            return;
          }
          if (first !== second) {
            new Notice("两次输入不一致。");
            return;
          }
          // 真机 bug 修复（2026-10-18「无对应弹窗显示」）：
          // ①保存链路必须可见失败——首版 await hashPassword/saveSettings 无 try/catch，
          //    任何异常=按钮没反应、无 data.json、无提示（静默黑洞）。
          // ②设完必须主动上锁已打开的终端视图——闸门原先只在 onOpen 检查，而视图
          //    往往一直开着（onOpen 不重跑）→ 设完密码也永远看不到弹窗。
          try {
            this.plugin.settings.password = await hashPassword(first);
            // 改密后当天也要重新验证一次（与 learning-radar 的 generation 吊销同理）。
            this.plugin.settings.passwordDay = undefined;
            await this.plugin.saveSettings();
          } catch (error) {
            console.error("[莱茵档案终端] 保存密码失败", error);
            new Notice(`莱茵档案终端：保存密码失败——${String(error).slice(0, 80)}`);
            return;
          }
          let locked = 0;
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RHINE)) {
            if (leaf.view instanceof RhineArchiveView) { leaf.view.lockNow(); locked++; }
          }
          new Notice(
            changing ? "莱茵档案终端：密码已更新。" : "莱茵档案终端：密码已设置。",
          );
          if (locked) new Notice("莱茵档案终端：终端视图已上锁，重新打开即需输入密码。");
          this.display();
        }),
      )
      .addButton((button) => button.setButtonText("取消").onClick(() => this.display()));
  }
}

export default RhineArchivePlugin;
