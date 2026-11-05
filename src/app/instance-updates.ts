import { InstancedBufferAttribute } from "three";

/**
 * 只上传「真正变了的那一段」实例数据。
 *
 * 背景：阵列是 5 个 InstancedMesh（不同材质/部件）共用同一批实例变换，
 * 每帧都要写回几百个 4x4 矩阵。原做法每帧对整块缓冲置 needsUpdate=true，
 * 等于每帧把整张表重传给显卡（约 18 万字节 × 6 次）。
 *
 * 本类先逐值比较 Float32（与 GPU 实际收到的数值一致），只记录变化区间的首尾，
 * commit() 时用 addUpdateRange 上传这一个连续区间。
 *
 * 约束（改动前务必确认）：只有「所有实例属性永远整块一起变」才适用；
 * 若将来出现只改某几个实例、且需要在同一帧内分多次上传的用法，需要重新评估。
 */
export class InstanceUpdates {
  private first = Infinity;
  private last = -1;
  readonly attribute: InstancedBufferAttribute;
  constructor(attribute: InstancedBufferAttribute) { this.attribute = attribute; }
  set(offset: number, values: ArrayLike<number>) {
    const array = this.attribute.array;
    for (let j = 0; j < values.length; j++) {
      const i = offset + j, value = Math.fround(values[j]);
      if (array[i] === value) continue;
      array[i] = value;
      this.first = Math.min(this.first, i);
      this.last = Math.max(this.last, i);
    }
  }
  scalar(offset: number, value: number) {
    value = Math.fround(value);
    if (this.attribute.array[offset] === value) return;
    this.attribute.array[offset] = value;
    this.first = Math.min(this.first, offset);
    this.last = Math.max(this.last, offset);
  }
  commit() {
    if (this.last < 0) return false;
    // 没有发生绘制的帧里挂起的区间不能被丢掉，留到下一次 commit 一起上传。
    this.attribute.addUpdateRange(this.first, this.last - this.first + 1);
    this.attribute.needsUpdate = true;
    this.first = Infinity;
    this.last = -1;
    return true;
  }
}
