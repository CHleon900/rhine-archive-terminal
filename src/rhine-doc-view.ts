import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
} from "obsidian";

export const VIEW_TYPE_RHINE_DOC = "rhine-doc-view";

export interface DocRecord {
  id: string;
  title: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  path: string;
  dir: string;
}

/** Narrow host surface so this view stays decoupled from the plugin class. */
export interface DocHost {
  recordFor(path: string): DocRecord | undefined;
  openDoc(path: string, leaf?: WorkspaceLeaf): Promise<void>;
  openEditable(path: string): Promise<void>;
  openNative(path: string): void;
  openTerminal(): void;
  revealPath(path: string): void;
}

const ROOT_LABEL = "MEMORY";

/**
 * Terminal-styled reader for a single note. Rendered entirely by this plugin
 * (Obsidian's own MarkdownRenderer produces the body), so the native reading
 * view, themes and other plugins stay untouched.
 */
export class RhineDocView extends ItemView {
  private host: DocHost;
  private path = "";
  private bodyComponent: Component | null = null;

  constructor(leaf: WorkspaceLeaf, host: DocHost) {
    super(leaf);
    this.host = host;
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_RHINE_DOC;
  }

  getDisplayText() {
    const name = this.path.split("/").pop() ?? "";
    return name.replace(/\.md$/, "") || "档案";
  }

  getIcon() {
    return "file-text";
  }

  async onOpen() {
    this.contentEl.addClass("rhine-doc-view");
    await this.render();
  }

  async onClose() {
    this.unloadBody();
  }

  async setState(state: unknown, result: ViewStateResult) {
    const next = (state as { path?: unknown } | null)?.path;
    if (typeof next === "string" && next) this.path = next;
    await super.setState(state, result);
    if (this.contentEl.isConnected) await this.render();
  }

  private unloadBody() {
    this.bodyComponent?.unload();
    this.bodyComponent = null;
  }

  private async render() {
    const { contentEl, app } = this;
    this.unloadBody();
    contentEl.empty();
    contentEl.addClass("rhine-doc-view");

    const file = this.path ? app.vault.getAbstractFileByPath(this.path) : null;
    if (!(file instanceof TFile)) {
      const box = contentEl.createDiv({ cls: "rdv-missing" });
      box.createDiv({ cls: "rdv-missing-title", text: "ARCHIVE NOT FOUND" });
      box.createDiv({ text: this.path || "未指定档案路径" });
      const back = box.createEl("button", { cls: "rdv-action", text: "← 返回档案阵列" });
      back.onclick = () => this.host.openTerminal();
      return;
    }

    const record = this.host.recordFor(this.path);
    const title = record?.title || file.basename;
    const category = record?.category || this.parentLabel();
    const location = record?.department || this.parentLabel() || ROOT_LABEL;

    let body = "";
    try {
      const raw = await app.vault.cachedRead(file);
      // frontmatter 由 HUD 呈现，正文里剥掉，避免重复。
      body = raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    } catch (error) {
      const box = contentEl.createDiv({ cls: "rdv-missing" });
      box.createDiv({ cls: "rdv-missing-title", text: "READ FAILED" });
      box.createDiv({ text: String(error instanceof Error ? error.message : error) });
      const native = box.createEl("button", {
        cls: "rdv-action",
        text: "在 Obsidian 中打开 ↗",
      });
      native.onclick = () => this.host.openNative(this.path);
      return;
    }

    // 底色质感：氛围层（模拟 3D 场景光线）+ 磨砂纱（原项目 .modal-backdrop 配方）
    contentEl.createDiv({ cls: "rdv-atmos" });
    contentEl.createDiv({ cls: "rdv-veil" });
    contentEl.createDiv({ cls: "rdv-scan" });

    // ---------- 顶栏 ----------
    const top = contentEl.createDiv({ cls: "rdv-top" });
    const crumb = top.createDiv({ cls: "rdv-crumb" });
    crumb.createSpan({ cls: "rdv-crumb-root", text: ROOT_LABEL });
    const segments = location
      .split(" / ")
      .filter((segment) => segment && segment !== ROOT_LABEL);
    // 层级过深时折叠中段，避免被右侧按钮挤压
    const shown = segments.length > 2
      ? [segments[0], "…", segments[segments.length - 1]]
      : segments;
    for (const segment of shown) {
      crumb.createSpan({ cls: "rdv-crumb-sep", text: "／" });
      crumb.createSpan({ cls: "rdv-crumb-item", text: segment });
    }
    const actions = top.createDiv({ cls: "rdv-actions" });
    const back = actions.createEl("button", { cls: "rdv-action", text: "← ARCHIVE OVERVIEW" });
    back.onclick = () => this.host.openTerminal();
    const editTop = actions.createEl("button", {
      cls: "rdv-action",
      text: "EDIT IN OBSIDIAN ↗",
    });
    editTop.onclick = () => void this.host.openEditable(this.path);

    // ---------- 文档区 ----------
    const doc = contentEl.createDiv({ cls: "rdv-doc" });
    const kicker = doc.createDiv({ cls: "rdv-kicker" });
    kicker.createSpan({
      cls: "rdv-file",
      text: record?.id ? `FILE ${record.id}` : "FILE",
    });
    kicker.createSpan({ cls: "rdv-status", text: record?.clearance || "" });

    doc.createEl("h1", { cls: "rdv-title", text: title });
    if (category) doc.createDiv({ cls: "rdv-cat", text: category });
    doc.createDiv({ cls: "rdv-rule" });

    const meta = doc.createDiv({ cls: "rdv-meta" });
    const cell = (label: string, value: string, cls = "") => {
      const box = meta.createDiv({
        cls: cls ? `rdv-cell ${cls}` : "rdv-cell",
      });
      box.createEl("small", { text: label });
      box.createSpan({ text: value || "—" });
    };
    cell("LOCATION / 位置", location);
    cell("DATE / 日期", record?.date ?? "");
    cell("TAGS / 标签", record?.lead ?? "");
    cell("STATUS / 状态", record?.clearance ?? "", "rdv-cell-status");

    const bodyEl = doc.createDiv({ cls: "rdv-body markdown-rendered" });
    this.bodyComponent = new Component();
    this.addChild(this.bodyComponent);
    try {
      await MarkdownRenderer.render(app, body, bodyEl, this.path, this.bodyComponent);
    } catch (error) {
      bodyEl.createDiv({
        cls: "rdv-render-failed",
        text: `正文渲染失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.bindBodyLinks(bodyEl);

    // ---------- 底栏 ----------
    const foot = contentEl.createDiv({ cls: "rdv-foot" });
    const reveal = foot.createEl("button", { cls: "rdv-solid", text: "REVEAL FILE" });
    reveal.createSpan({ cls: "rdv-solid-hint", text: "显示源文件" });
    reveal.onclick = () => this.host.revealPath(this.path);
    const edit = foot.createEl("button", {
      cls: "rdv-ghost",
      text: "EDIT IN OBSIDIAN ↗",
    });
    edit.onclick = () => void this.host.openEditable(this.path);
    foot.createDiv({ cls: "rdv-foot-path", text: this.path });
  }

  /** 内链 → 在本视图内切换（终端风格连续阅读）；外链 → 系统浏览器。 */
  private bindBodyLinks(bodyEl: HTMLElement) {
    bodyEl.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const internal = target.closest("a.internal-link") as HTMLElement | null;
      if (internal?.dataset.href) {
        event.preventDefault();
        const dest = this.app.metadataCache.getFirstLinkpathDest(
          internal.dataset.href,
          this.path,
        );
        if (dest) {
          void this.host.openDoc(dest.path, this.leaf);
        }
        return;
      }
      const external = target.closest("a.external-link") as HTMLAnchorElement | null;
      if (external?.href) {
        event.preventDefault();
        window.open(external.href, "_blank");
      }
    });
  }

  private parentLabel() {
    const parts = this.path.split("/").slice(0, -1);
    return parts.join(" / ");
  }
}
