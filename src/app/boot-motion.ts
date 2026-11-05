// Original footage is 25 fps. App time zero corresponds to video time 5 s.
// Discrete editorial cuts use frame numbers; spatial motion uses continuous time.
import { galleryName } from "./brand";
import { brandTrack, companyTrack, scanTrack, track } from "./boot-tracks";
import { scanOrbitTrack } from "./boot-orbit-tracks";
import { bootLogoTrack } from "./boot-logo-tracks";
export const progress = (t: number, a: number, b: number) =>
  Math.max(0, Math.min(1, (t - a) / (b - a)));
export const smooth = (p: number) => p * p * (3 - 2 * p);
const typed = (text: string, f: number, start: number, end: number) =>
  text.slice(
    0,
    f < start
      ? 0
      : Math.min(
          text.length,
          1 + Math.floor(((f - start) * (text.length - 1)) / (end - start)),
        ),
  );
const at = (f: number, frames: number[]) => frames.includes(f);
const accessCounts = [
  1, 1, 3, 4, 5, 6, 9, 11, 12, 14, 17, 18, 19, 20, 22, 23, 25, 26,
];

/** POWERED BY 行的完整长度（随展廊名变化），供逐字 clip 分母使用。 */
export const poweredLineLength = `POWERED BY ${galleryName}`.length;

export function bootMotion(appTime: number) {
  const t = appTime + 5;
  const f = Math.floor(t * 25 + 0.00001);
  const step =
    t < 9.12
      ? "access"
      : t < 11.12
        ? "logo"
        : t < 19.48
          ? "auth"
          : t < 22.76
            ? "scan"
            : "welcome";
  let auth = "";
  if (f < 363) {
    auth = typed("ID CONFIRMED", f, 282, 295);
    if (f >= 320) auth += " : " + typed("JOYCE MOORE", f, 321, 339);
  } else if (f < 421) auth = typed("REQUEST RECEIVED", f, 367, 389);
  else {
    auth = typed("START PROCESSING", f, 423, 440);
    if (f >= 449)
      auth += ".".repeat(Math.min(3, 1 + Math.floor((f - 449) / 4)));
    if (at(f, [479, 485, 486])) auth = "              SING...";
  }
  const frame = t * 25;
  const scan = scanTrack(frame);
  const scanOrbit = scanOrbitTrack(frame);
  const scanGlitch = at(f, [525, 526, 528, 529]);
  const welcomeIntro = [1, 0, 0.28, 0, 1, 0, 0];
  const flashIndex = f - 569;
  const exit = smooth(progress(t, 26.56, 26.92));
  return {
    t,
    f,
    step,
    auth,
    access: "ACCESS PERMISSION REQUIRED".slice(
      0,
      f < 170 ? 0 : accessCounts[Math.min(17, f - 170)],
    ),
    accessOpacity: f >= 170 && f < 227 ? (f === 226 ? 0.25 : 1) : 0,
    logoOpacity: t >= 9.16 && t < 19.48 ? 1 : 0,
    logo: bootLogoTrack(frame),
    logoLetters: typed(galleryName.replace(/ /g, "·"), f, 232, 255),
    authOpacity: f >= 281 && f < 487 ? 1 : 0,
    brand: [0, 1, 2].map((line) => brandTrack(frame, line)),
    poweredLetters: typed(`POWERED BY ${galleryName}`, f, 279, 295).length,
    scanVisible: t >= 19.48 && t < 22.76,
    scan,
    scanOrbit,
    scanRadius: scan.radius,
    ringScale: scanGlitch ? 1.94 : 1,
    ringOpacity: scanGlitch
      ? 0.32
      : track(
          [
            [487, 0],
            [488, 0.18],
            [490, 0.6],
            [493, 1],
          ],
          frame,
        ),
    ringBlur: scanGlitch ? 2.2 : 0,
    scanTracking: track(
      [
        [487, 40],
        [492, 28],
        [497, 18],
        [500, 14],
        [505, 8],
        [510, 4],
        [515, 1.7],
        [520, 0.5],
        [527, 0],
        [568, 0],
      ],
      frame,
    ),
    scanFont: 26.5,
    permissionOpacity:
      t < 21.8
        ? progress(t, 19.48, 19.88)
        : track(
            [
              [545, 1],
              [546, 0.4],
              [547, 0.3],
              [548, 0.25],
              [549, 0.1],
              [550, 0.04],
              [551, 0],
            ],
            frame,
          ),
    ornament: t >= 21.84,
    coreRadius: scanOrbit.coreRadius,
    welcomeVisible: t >= 22.76 && t < 26.92,
    welcomePanel:
      flashIndex >= 0 && flashIndex < 7 ? welcomeIntro[flashIndex] : 0,
    welcomeInk:
      flashIndex >= 0 && flashIndex < 7
        ? [0, 0, 0.2, 1, 0, 0, 0.25][flashIndex]
        : 1,
    companyVisible: f >= 588 && !at(f, [590, 591]),
    companyMask: at(f, [594, 595]),
    highlight: companyTrack(frame),
    databaseOpacity: f < 626 || at(f, [628, 629, 631, 634]) ? 0 : 1,
    welcomeLogo: f >= 588,
    welcomeScale: 1 - 0.46 * exit,
    welcomeOpacity: 1 - Math.pow(exit, 3),
    exitBlur: 8 * exit,
    exit,
    // 白场收尾（v8.9.17）：原实现是 t<26.92 恒 1、到点【硬切】0——白层是
    // #boot-background 的子元素，父级透明度归零会把刚升满的白层一起瞬移消失，
    // 于是「纸底 230 → 242 → 一帧纯 255 → 阵列 220」里出现一次满白闪烁。
    // 现在让父级在最后 0.22s 内淡出（白层随之淡出）：白场峰值与时长按原片保留，
    // 但交给阵列的是一次连续溶解，而不是一帧硬切。
    backgroundOpacity: 1 - smooth(progress(t, 26.86, 27.08)),
    white: smooth(progress(t, 26.16, 26.88)),
  };
}
