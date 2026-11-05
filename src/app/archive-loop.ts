import { archiveColumns, columnFiles, fileLocation } from "./data.ts";

export type ArchiveCell = { lane: number; row: number };
export type ArchiveNavigation =
  { axis: "row" | "lane"; direction: number } | { cell: ArchiveCell };

export const LOOP_COLUMNS = 9;
export const LOOP_ROWS = 32;
export const COLUMN_SPACING = 5.2;
export const ROW_SPACING = 0.62;
const POOL_LANES = [0, 1, 2, 3, 4, -2, -1, 5, 6];

export function wrap(value: number, count: number) {
  return ((value % count) + count) % count;
}

// Choose an occurrence of an item in an unbounded sequence. Directional moves
// use adjacent cells instead, so the last-to-first transition never reverses.
export function nearestOccurrence(
  value: number,
  center: number,
  period: number,
) {
  return value + Math.floor((center - value + period / 2) / period) * period;
}

export function fileAtCell({ lane, row }: ArchiveCell) {
  const laneIndex = wrap(lane, archiveColumns.length);
  const files = columnFiles(laneIndex);
  // 镜像车道（lane 超出主列 0..n-1 范围）与主车道共享同一列档案；按车道带
  // 偏移一行起点，避免相邻车道同一行显示完全相同的书脊内容。选中对齐不受
  // 影响：fileLocation 的 lane 恒在 0..n-1（band=0），selectionCell 生成的
  // 行偏移经 wrap 仍落回同一格。
  const band = Math.round((lane - laneIndex) / archiveColumns.length);
  return files[wrap(row - 12 + band, files.length)];
}

export function selectionCell(
  index: number,
  current: ArchiveCell,
  navigation?: ArchiveNavigation,
): ArchiveCell {
  if (navigation && "cell" in navigation) return { ...navigation.cell };
  const next = fileLocation(index);
  const row = nearestOccurrence(
    next.row,
    current.row,
    columnFiles(next.lane).length,
  );
  if (navigation?.axis === "row") {
    return { lane: current.lane, row: current.row + navigation.direction };
  }
  return {
    lane:
      navigation?.axis === "lane"
        ? current.lane + navigation.direction
        : nearestOccurrence(next.lane, current.lane, archiveColumns.length),
    row,
  };
}

// Preserve the reference animation's original first 160 instances. The four
// extra columns form a hidden margin on either side during interactive use.
export function poolCell(index: number): ArchiveCell {
  return {
    lane: POOL_LANES[Math.floor(index / LOOP_ROWS)],
    row: index % LOOP_ROWS,
  };
}

export function visibleCell(index: number, center: ArchiveCell): ArchiveCell {
  return {
    lane: nearestOccurrence(
      POOL_LANES[Math.floor(index / LOOP_ROWS)],
      center.lane,
      LOOP_COLUMNS,
    ),
    row: nearestOccurrence(index % LOOP_ROWS, center.row, LOOP_ROWS),
  };
}

export function cellKey(cell: ArchiveCell) {
  return `${cell.lane}:${cell.row}`;
}

// —— 短列重复副本的墨色淡出（2026-10-17 方案 2，用户此前已认可方向）——
// 一列笔记数 < 可见 32 行时，循环阵列必然把同一份档案显示多次（记忆层只有
// 2 篇 → 整墙同号）。处置=最靠近视口中心的那次保持全浓度，其余副本按
// 「离自己主副本隔了几个周期」淡出。
// 副本沿行轴每隔 len 行出现一次 ⇒ 距主副本的周期数 m = |round((row - centerRow) / len)|。
// len ≥ 32（窗口半高 16 ≤ len/2）时 m 恒为 0 → 长列自然不受影响，无需特判。
export function duplicateRank(lane: number, row: number, centerRow: number) {
  const laneIndex = wrap(lane, archiveColumns.length);
  const len = columnFiles(laneIndex).length || 1;
  return Math.abs(Math.round((row - centerRow) / len));
}
export function inkForRank(rank: number) {
  return rank === 0 ? 1 : Math.max(0.3, 1 - 0.45 * rank);
}

export function sameCell(a: ArchiveCell, b: ArchiveCell) {
  return a.lane === b.lane && a.row === b.row;
}
