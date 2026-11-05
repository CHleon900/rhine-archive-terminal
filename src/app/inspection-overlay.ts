import {
  SCAN_FROM,
  SCAN_TO,
  SCAN_CORNERS,
  type DecryptionFrame,
} from "./decryption";

export function inspectionSegments(frame: DecryptionFrame) {
  const point = (t: number): [number, number] => [
    SCAN_FROM[0] + (SCAN_TO[0] - SCAN_FROM[0]) * t,
    SCAN_FROM[1] + (SCAN_TO[1] - SCAN_FROM[1]) * t,
  ];
  return frame.intervals.map(([a, b]) => [point(a), point(b)] as const);
}

export class InspectionOverlay {
  private root = document.querySelector<SVGSVGElement>("#inspection-marks")!;
  private line = this.root.querySelector<SVGPathElement>("#inspection-lines")!;
  private corners = this.root.querySelector<SVGGElement>(
    "#inspection-corners",
  )!;
  private point =
    this.root.querySelector<SVGCircleElement>("#inspection-point")!;
  private label = document.querySelector<HTMLElement>("#inspection-text")!;

  /**
   * 2026-10-17 用户裁定（截图圈出卡面斜线，「总是出现再消失，没必要」→ 选择「直接去掉」）：
   * 交互路径（点开档案进详情）不再绘制扫描线。理由：详情直显（DecryptionController
   * .instantClear，2026-10-15 裁定）已让磨砂 0.6 秒变清晰，而这条线还要演满 3.6 秒
   * （长出→保持→收回），揭示功能已被取代，剩下只是压在卡面文字上的装饰。
   *
   * 仅保留 cinematic 路径（开机动画重现原片 34.12–39.56s 的解密段）的完整渲染——
   * 那是原片艺术的一部分，且每天只播一次，不是用户抱怨的场景。
   */
  render(
    frame: DecryptionFrame,
    project: (x: number, y: number) => number[],
    cinematic: boolean,
  ) {
    if (!cinematic) {
      if (this.root.style.opacity !== "0") this.root.style.opacity = "0";
      if (this.label.style.opacity !== "0") this.label.style.opacity = "0";
      return;
    }
    const host = document.querySelector<HTMLElement>("#three-scene")!;
    this.root.setAttribute("viewBox", `0 0 ${host.clientWidth} ${host.clientHeight}`);
    this.root.style.opacity =
      frame.intervals.length || frame.markers > 0 || frame.point > 0
        ? "1"
        : "0";
    this.root.dataset.phase = frame.phase;
    this.root.dataset.referenceTime = frame.time.toFixed(3);
    this.line.setAttribute(
      "d",
      inspectionSegments(frame)
        .map(([a, b]) => `M${project(...a)}L${project(...b)}`)
        .join(""),
    );
    this.corners.style.opacity = String(frame.markers);
    this.corners.innerHTML =
      frame.markers > 0
        ? SCAN_CORNERS.map(([x, y]) => {
            const [px, py] = project(x, y);
            return `<rect x="${px - 4}" y="${py - 4}" width="8" height="8"/>`;
          }).join("")
        : "";
    const [cx, cy] = project(
      (SCAN_FROM[0] + SCAN_TO[0]) / 2,
      (SCAN_FROM[1] + SCAN_TO[1]) / 2,
    );
    this.point.setAttribute("cx", String(cx));
    this.point.setAttribute("cy", String(cy));
    this.point.style.opacity = String(frame.point);
    this.label.style.opacity = String(frame.label);
    this.label.querySelector<HTMLElement>("strong")!.style.opacity = String(
      frame.labelValue,
    );
  }
}
