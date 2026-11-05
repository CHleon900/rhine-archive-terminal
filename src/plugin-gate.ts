/**
 * 密码闸门（门禁式，用户 2026-10-14 三问三答定稿 + 2026-10-18 频率裁定）。
 *
 * 为什么装在宿主侧（本文件）而不是终端 iframe 里：
 *   iframe 里做门禁等于「先把整库数据塞进页面，再盖一层帘子」——挡住看不见，
 *   但 F12 一看就有全部内容。这里在 buildArchiveData 之前拦，数据根本不下发。
 *   （调研 learning-radar 印证了同一结论：验证在发数据之前，不是画面前面。）
 *
 * 哈希：PBKDF2-SHA256（浏览器 WebCrypto 原生；浏览器没有 scrypt）。
 *   30 万次迭代 + 16 字节随机盐，产物 32 字节。单次校验约 0.2~0.4s，用户无感。
 *   边界如实说明：本地明文只存盐与派生值，防的是"随手翻看"，不防拿工具挖 data.json。
 */
const ITERATIONS = 300_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export interface StoredPassword {
  salt: string;
  hash: string;
  iterations: number;
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** 定长比较：不因前缀匹配提前返回（削弱计时侧信道）。 */
const equalBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  // TS 5.7 起 Uint8Array 泛型化为 Uint8Array<ArrayBufferLike>，与 BufferSource 不兼容；
  // 这里取底层 ArrayBuffer 传参（WebCrypto 实际接受 ArrayBufferView）。
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuffer, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<StoredPassword> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return { salt: toBase64(salt), hash: toBase64(hash), iterations: ITERATIONS };
}

export async function verifyPassword(
  password: string,
  stored: StoredPassword | undefined,
): Promise<boolean> {
  if (!stored?.salt || !stored.hash) return false;
  try {
    const expected = fromBase64(stored.hash);
    const actual = await derive(password, fromBase64(stored.salt), stored.iterations || ITERATIONS);
    return equalBytes(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 失败退避（借 learning-radar 的做法）：前两次不惩罚，第 3 次起 5 秒，
 * 之后每次翻倍，封顶 60 秒。只在内存里记，重启插件即清零——
 * 本地单人场景下，持久化反而会让用户自己被锁在门外。
 */
export class LoginBackoff {
  private failures = 0;
  private until = 0;
  // 不用构造函数参数属性（`constructor(private now...)`）：Node 24 的 strip-only
  // TS 模式不支持，会让 verify-gate-logic.mjs 直接跑不起来。显式字段保持可注入假时钟。
  private now: () => number;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }
  get remaining(): number {
    return Math.max(0, this.until - this.now());
  }
  get blocked(): boolean {
    return this.remaining > 0;
  }
  fail() {
    this.failures += 1;
    if (this.failures < 3) return;
    const seconds = Math.min(60, 5 * 2 ** (this.failures - 3));
    this.until = this.now() + seconds * 1000;
  }
  reset() {
    this.failures = 0;
    this.until = 0;
  }
}

/** 当天标记（与终端侧 BOOT_DAY_KEY 同一种「按本地日期」的判定）。 */
export const dayStamp = () => new Date().toLocaleDateString("sv-SE");

/** 极简 DOM helper：宿主侧不引第三方，也不依赖 app.css（那是 iframe 内用的）。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}
