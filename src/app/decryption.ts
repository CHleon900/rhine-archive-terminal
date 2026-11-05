// Measured against the local reference at 25 fps. Times here are ORIGINAL video
// seconds, unlike the camera's historical (original minus five) time convention.
export const DECRYPTION_START = 34.12;
export const DECRYPTION_END = 39.56;
const INTERACTIVE_RATE = 1.5;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const x = clamp(value);
  return x * x * x * (10 + x * (-15 + x * 6));
};

type Knot = readonly [number, number];
// Monotone cubic Hermite interpolation preserves the measured easing without
// overshoot or velocity jumps at a frame sample. End velocities are zero.
export function sampleCurve(knots: readonly Knot[], time: number) {
  if (time <= knots[0][0]) return knots[0][1];
  if (time >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];
  const secant = (i: number) =>
    (knots[i + 1][1] - knots[i][1]) / (knots[i + 1][0] - knots[i][0]);
  const slope = (i: number) => {
    if (i === 0 || i === knots.length - 1) return 0;
    const a = secant(i - 1),
      b = secant(i);
    if (a * b <= 0) return 0;
    const left = knots[i][0] - knots[i - 1][0],
      right = knots[i + 1][0] - knots[i][0];
    const w1 = 2 * right + left,
      w2 = right + 2 * left;
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  let i = 0;
  while (time > knots[i + 1][0]) i++;
  const span = knots[i + 1][0] - knots[i][0],
    t = (time - knots[i][0]) / span,
    t2 = t * t,
    t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * knots[i][1] +
    (t3 - 2 * t2 + t) * span * slope(i) +
    (-2 * t3 + 3 * t2) * knots[i + 1][1] +
    (t3 - t2) * span * slope(i + 1)
  );
}

const GROW: readonly Knot[] = [
  [34.24, 0],
  [34.4, 0.19],
  [34.64, 0.57],
  [34.96, 0.79],
  [35.28, 0.92],
  [35.6, 0.973],
  [36.04, 1],
];
// The clearing front starts when the line finishes retracting. At 39.0 s
// the upper half is already readable; height-dependent roughness moves with it.
const REVEAL: readonly Knot[] = [
  [38.84, 0],
  [38.92, 0.28],
  [39.0, 0.51],
  [39.16, 0.74],
  [39.32, 0.94],
  [39.56, 1],
];
const RETRACT: readonly Knot[] = [
  [37.72, 1],
  [37.88, 0.72],
  [38.0, 0.38],
  [38.12, 0.22],
  [38.24, 0.14],
  [38.4, 0.075],
  [38.64, 0.024],
  [38.84, 0],
];

// Endpoints measured on the face at 37 seconds. Every moving endpoint is on
// this ONE diagonal in model space; projection carries it with the camera.
// 竖版映射（x×4.0/5.01、y×5.0/3.7）：解密播放于 detail=1，model 局部已是竖版单位。
export const SCAN_FROM = [-1.28, 0.68] as const;
export const SCAN_TO = [1.58, 4.38] as const;
export const SCAN_CORNERS = [
  [-1.5, 4.32],
  [1.71, 4.54],
  [-1.41, 0.49],
  [1.73, 0.88],
] as const;

export function decryptionFrame(time: number) {
  const grow = sampleCurve(GROW, time);
  const remaining = sampleCurve(RETRACT, time);
  const intervals: [number, number][] = [];
  if (time >= 34.24 && time < 36.04 && grow > 0)
    intervals.push([0, grow * 0.5], [1 - grow * 0.5, 1]);
  else if (time >= 36.04 && time < 38.84)
    intervals.push([0.5 - remaining * 0.5, 0.5 + remaining * 0.5]);
  const markers =
    smooth((time - 34.2) / 0.12) * (1 - smooth((time - 37.76) / 0.56));
  return {
    time,
    intervals,
    markers,
    point: smooth((time - 38.58) / 0.2) * (1 - smooth((time - 39.08) / 0.22)),
    label: smooth((time - 34.32) / 0.36) * (1 - smooth((time - 37.68) / 0.24)),
    labelValue: smooth((time - 35.64) / 0.56),
    clarity: sampleCurve(REVEAL, time),
    phase:
      time < 34.24
        ? "waiting"
        : time < 36.04
          ? "joining"
          : time < 37.72
            ? "connected"
            : time < 38.84
              ? "retracting"
              : time < DECRYPTION_END
                ? "revealing"
                : "clear",
  };
}
export type DecryptionFrame = ReturnType<typeof decryptionFrame>;

export class DecryptionController {
  clarity = 0;
  /** 详情直显（2026-10-15 用户裁定「抽出卡片到这详情页的时候我觉得可以直接去掉模糊」）：
   *  进入详情即盖板直接变清晰（约 0.4 秒收敛，不闪跳），不再等原片 38.84–39.56 的
   *  磨砂揭示曲线；扫描线解密动画照常播放。仅作用于交互路径——原片对照
   *  （referenceTime）与退回阵列的再磨砂（leave 后衰减）均不受影响。 */
  instantClear = true;
  private active = false;
  private elapsed: number | null = null;
  frame: DecryptionFrame = decryptionFrame(-1);

  enter(alreadyClear = false) {
    if (this.active) return;
    this.active = true;
    this.elapsed = alreadyClear
      ? (DECRYPTION_END - DECRYPTION_START) / INTERACTIVE_RATE
      : null;
    if (alreadyClear) this.finish();
  }
  leave() {
    this.active = false;
    this.elapsed = null;
    this.frame = decryptionFrame(-1);
  }
  select(clarity = 0) {
    this.leave();
    this.clarity = clarity;
  }
  finish() {
    this.elapsed = (DECRYPTION_END - DECRYPTION_START) / INTERACTIVE_RATE;
    this.clarity = 1;
    this.frame = decryptionFrame(DECRYPTION_END);
  }
  update(dt: number, ready: boolean, reduced: boolean, referenceTime?: number) {
    if (referenceTime !== undefined) {
      this.frame = decryptionFrame(referenceTime);
      this.clarity = this.frame.clarity;
      return;
    }
    if (!this.active) {
      this.clarity = reduced
        ? 0
        : this.clarity * Math.exp(-Math.max(0, dt) * 9);
      if (this.clarity < 0.0001) this.clarity = 0;
      this.frame = decryptionFrame(-1);
      return;
    }
    if (reduced) {
      this.finish();
      return;
    }
    if (this.elapsed === null && ready) this.elapsed = 0;
    else if (this.elapsed !== null)
      this.elapsed = Math.min(
        this.elapsed + Math.max(0, dt),
        (DECRYPTION_END - DECRYPTION_START) / INTERACTIVE_RATE,
      );
    if (this.elapsed !== null) {
      this.frame = decryptionFrame(
        DECRYPTION_START + this.elapsed * INTERACTIVE_RATE,
      );
      // Re-entry during refrosting starts from the displayed material state.
      const curve =
        this.frame.clarity > this.clarity
          ? this.frame.clarity
          : this.frame.phase === "clear"
            ? 1
            : this.clarity * Math.exp(-Math.max(0, dt) * 9);
      // 详情直显时禁止再磨砂衰减（否则与下方提清爬坡对拉，动画中途回糊）。
      this.clarity = this.instantClear ? Math.max(curve, this.clarity) : curve;
    }
    if (this.instantClear) {
      // 用户裁定（2026-10-15）：详情直显——盖板指数逼近全清（约 0.6 秒 95%），
      // 扫描线动画（frame）照常播放，仅材质不再等揭示曲线。
      this.clarity = Math.min(1, 1 - (1 - this.clarity) * Math.exp(-Math.max(0, dt) * 5));
    }
  }
}
