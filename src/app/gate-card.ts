/**
 * 进场内嵌密码闸门（2026-10-18 用户指导）：点击进入 → 居中内容块整体左移 →
 * 右侧滑出方形登录卡 → 验证成功 → 内容块回位 → 接原开机动画。
 * PBKDF2 验证与退避都在宿主（plugin-main.ts handleGateVerify）；
 * 验证通过前宿主不下发 RHINE_DATA，iframe 里 records 为空、场景也不创建。
 */
import "./gate-card.css";
import type { ArchiveRecord } from "./data";

declare global {
  interface Window {
    RHINE_GATE?: { required?: boolean; authorized?: boolean };
  }
}

/** 宿主在设了密码时注入；无密码环境下不存在。 */
export const gateRequired = Boolean(window.RHINE_GATE?.required);
/**
 * 当天已通过验证（2026-10-18 用户指导）：仍然先显示登录卡，但数据已随挂载下发、
 * 点击「登录」直接放行，不再向宿主校验——「即使已经输过密码了，也还是要先显示出
 * 但是可以直接点击登录再进行后面的动画」。
 */
export const gateAuthorized = Boolean(window.RHINE_GATE?.required && window.RHINE_GATE?.authorized);

type GateResult = {
  ok?: boolean;
  empty?: boolean;
  remaining?: number;
  records?: ArchiveRecord[];
};

function askHost(message: Record<string, unknown>, timeoutMs = 30000): Promise<GateResult | null> {
  return new Promise((resolve) => {
    let done = false;
    const listener = (event: MessageEvent) => {
      // 宿主回传形态：{source:"rhine-host", type:"rhine-gate-result", result:{ok,records,remaining}}
      // （plugin-main.ts postGateResult 把载荷包在 result 里，顶层没有 ok/records）。
      const data = event.data as
        | (GateResult & { source?: string; type?: string; result?: GateResult })
        | null;
      if (data?.source !== "rhine-host" || data.type !== "rhine-gate-result") return;
      const result = data.result;
      if (!result || result.ok === undefined) return; // 等真正的 result 载荷
      done = true;
      window.removeEventListener("message", listener);
      resolve(result);
    };
    window.addEventListener("message", listener);
    window.setTimeout(() => {
      if (done) return;
      window.removeEventListener("message", listener);
      resolve(null);
    }, timeoutMs);
    try {
      window.parent.postMessage({ source: "rhine-terminal", ...message }, "*");
    } catch {
      window.removeEventListener("message", listener);
      resolve(null);
    }
  });
}

/** 等两帧，保证卡片初始态（右侧屏外、透明）先完成一次绘制，位移过渡才会触发。 */
const waitFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/**
 * 打开闸门卡并循环验证直到成功。成功时卡片退场与内容块回位的动画在后台收尾，
 * 本函数立即返回宿主下发的档案记录（调用方随即 setData + 加载场景 + completeStartup）。
 * 返回 [] = 验证通过但档案为空；返回 null = 宿主异常（理论上不可达）。
 */
export async function runGateFlow(
  loading: HTMLElement,
  reduced: boolean,
): Promise<ArchiveRecord[] | null> {
  const layer = document.createElement("div");
  layer.className = "gate-layer";
  const card = document.createElement("div");
  card.className = "gate-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "访问验证");
  card.innerHTML = `
    <div class="gate-head"><i class="gate-mark"></i><span class="gate-head-title">INTERNAL DATABASE</span><span class="gate-head-sub">内部终端</span></div>
    <div class="gate-band">
      <h2 class="gate-title">登录莱茵档案</h2>
      <p class="gate-sub">输入访问密码以解锁内部资料库。</p>
    </div>
    <div class="gate-band gate-band-input">
      <label class="gate-label" for="gate-password"><span class="gate-label-cn">密码</span><span>PASSWORD</span></label>
      <div class="gate-line">
        <input id="gate-password" class="gate-input" type="password" autocomplete="current-password" spellcheck="false" aria-label="访问密码">
      </div>
    </div>
    <p class="gate-status" role="status"></p>
    <div class="gate-actions">
      <button class="gate-submit" type="button">登录 · SIGN IN</button>
    </div>
    <p class="gate-footnote">INTERNAL ARCHIVE · AUTHORIZED PERSONNEL ONLY</p>`;
  layer.appendChild(card);
  loading.appendChild(layer);
  if (reduced) loading.classList.add("gate-instant");

  const input = card.querySelector<HTMLInputElement>(".gate-input")!;
  const status = card.querySelector<HTMLElement>(".gate-status")!;
  const submit = card.querySelector<HTMLButtonElement>(".gate-submit")!;

  /**
   * 状态行统一出口：色块与底色全部取消，只靠左侧 2px 竖线 + 文字色区分
   * （2026-10-18 用户指导 m06203：卡面/输入框/状态块共享同一底色，只由线条框定）。
   */
  const setStatus = (text: string, kind: "note" | "error" | "ok" = "note") => {
    status.textContent = text;
    status.classList.toggle("is-error", kind === "error");
    status.classList.toggle("is-ok", kind === "ok");
  };

  // 当天已通过验证（2026-10-18 用户指导）：卡片照常出现，但不必再输密码——
  // 点「登录/进入」直接放行，数据本次挂载已随 RHINE_DATA 下发。
  // m06467：不再在正文里挂一行「今日已验证 · 点击登录直接进入」的说明文字
  // （用户认为这串字「就这么出现比较丑」）——提示改由头部右侧小字承担，
  // 按钮自己换成「进入」，整个流程不需要额外解释。
  const authorized = gateAuthorized;
  if (authorized) {
    card.classList.add("is-authorized");
    const headSub = card.querySelector<HTMLElement>(".gate-head-sub");
    if (headSub) headSub.textContent = "今日已验证";
    const sub = card.querySelector<HTMLElement>(".gate-sub");
    if (sub) sub.textContent = "访问凭证仍在有效期内。";
    submit.textContent = "进入 · ENTER";
    input.setAttribute("aria-disabled", "true");
    input.tabIndex = -1;
    input.readOnly = true; // 已授权态不接受输入：不放光标、不弹键盘
  }

  // 卡片内的键盘与点击不外泄：StartupGate 的 Tab 圈与点击逻辑都挂在 loading 根上。
  card.addEventListener("keydown", (event) => event.stopPropagation());
  card.addEventListener("click", (event) => event.stopPropagation());

  // 挂起倒数（宿主只回剩余秒数，本地逐秒刷新，到期自动解除——与原宿主闸门同规则）。
  let blockedUntil = 0;
  let ticker: number | undefined;
  const setBlocked = (seconds: number) => {
    blockedUntil = Date.now() + seconds * 1000;
    submit.setAttribute("aria-disabled", "true");
    if (ticker !== undefined) return;
    ticker = window.setInterval(() => {
      if (!document.contains(card)) {
        window.clearInterval(ticker);
        ticker = undefined;
        return;
      }
      const left = Math.ceil((blockedUntil - Date.now()) / 1000);
      if (left > 0) {
        setStatus(`访问被挂起 · 请 ${left} 秒后再试`, "error");
      } else {
        window.clearInterval(ticker);
        ticker = undefined;
        blockedUntil = 0;
        submit.removeAttribute("aria-disabled");
        setStatus("挂起已解除 · 可重新验证");
        input.focus();
      }
    }, 500);
  };

  let wakeAttempt: (() => void) | null = null;
  const attempt = () => wakeAttempt?.();
  submit.addEventListener("click", attempt);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      attempt();
    }
  });
  const nextAttempt = () =>
    new Promise<void>((resolve) => {
      wakeAttempt = resolve;
    });

  // —— 打开：内容块左移、卡片从右滑入 ——
  await waitFrame();
  loading.classList.add("gate-open");
  // 已授权态把焦点给「登录」按钮（输入框是只读的，聚焦它只会露出一根无意义的光标）。
  window.setTimeout(() => (authorized ? submit.focus() : input.focus()), reduced ? 60 : 640);

  let records: ArchiveRecord[] | null = null;
  while (records === null) {
    await nextAttempt();
    wakeAttempt = null;
    if (!document.contains(card)) return null;
    if (blockedUntil) {
      setStatus(`访问被挂起，请 ${Math.ceil((blockedUntil - Date.now()) / 1000)} 秒后再试`, "error");
      continue;
    }
    if (authorized) {
      records =
        (window as unknown as { RHINE_DATA?: { records?: ArchiveRecord[] } }).RHINE_DATA?.records ?? [];
      submit.textContent = "进入中 …";
      setStatus("今日已验证 · 正在进入档案库…", "ok");
      break;
    }
    const value = input.value;
    if (!value) {
      setStatus("请输入访问密码", "error");
      continue;
    }
    submit.textContent = "验证中 …";
    setStatus("");
    const res = await askHost({ type: "rhine-gate-verify", password: value });
    submit.textContent = "登录 · SIGN IN";
    if (!res || res.ok === undefined) {
      setStatus("宿主无响应，请重试", "error");
      continue;
    }
    if (res.ok) {
      records = res.records ?? [];
      setStatus("验证通过，正在进入档案库…", "ok");
      break;
    }
    if ((res.remaining ?? 0) > 0) setBlocked(res.remaining!);
    else setStatus("ACCESS DENIED · 密码不正确，请重试", "error");
    if (!reduced) {
      // 抖动用 composite:add 叠加在既有 translateX(var(--gate-shift)) 上。
      card.animate(
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-8px)" },
          { transform: "translateX(8px)" },
          { transform: "translateX(0)" },
        ],
        { duration: 220, easing: "ease-out", composite: "add" },
      );
    }
    input.value = "";
    input.focus();
  }

  if (records === null) return null;
  if (!records.length) {
    // 空档案：不回位了，去掉开合状态，调用方会直接给出 DATABASE EMPTY。
    loading.classList.remove("gate-open");
    layer.remove();
    return records;
  }

  // —— 成功：卡片退场、内容块回位（动画后台收尾，不阻塞场景加载）——
  loading.classList.add("gate-done");
  loading.classList.remove("gate-open");
  window.setTimeout(() => layer.remove(), 720);
  return records;
}

