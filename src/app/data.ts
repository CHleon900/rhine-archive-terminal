/**
 * Obsidian plugin runtime: the vault scan result is injected by the host
 * plugin as window.RHINE_DATA before this bundle executes.
 * The terminal browses ONE directory level at a time; applyDirectory()
 * re-filters the full record set in place (arrays keep their identity so
 * every importing module sees the new view without re-import).
 */
declare global {
  interface Window {
    RHINE_DATA?: {
      records: ArchiveRecord[];
      categories: string[];
      columns: string[];
    };
  }
}

export interface ArchiveRecord {
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

const MAX_COLUMNS = 9;

const allRecords: ArchiveRecord[] = [];

/** Current view — arrays are mutated in place on directory change. */
export const records: ArchiveRecord[] = [];
export const categories = ["全部档案"];
export const archiveColumns: string[] = [];

/** Load the full vault scan (called once before the terminal starts). */
export function setData(data: { records: ArchiveRecord[] }) {
  allRecords.length = 0;
  allRecords.push(...data.records);
}

/**
 * Switch the active directory ("" = vault root / plugin folder setting).
 * Columns = direct sub-folders that contain notes (recursively) + a
 * "本层档案" column for notes sitting directly in this directory.
 */
export function applyDirectory(dir: string) {
  const prefix = dir ? dir + "/" : "";
  const subtree = allRecords.filter(
    (r) => r.dir === dir || r.dir.startsWith(prefix),
  );
  const groups = new Map<string, ArchiveRecord[]>();
  const direct: ArchiveRecord[] = [];
  for (const record of subtree) {
    const rel = record.dir.slice(prefix.length);
    if (!rel) {
      direct.push(record);
      continue;
    }
    const name = rel.split("/")[0];
    const bucket = groups.get(name);
    if (bucket) bucket.push(record);
    else groups.set(name, [record]);
  }

  const names = [...groups.keys()].sort(
    (a, b) =>
      groups.get(b)!.length - groups.get(a)!.length ||
      a.localeCompare(b, "zh-CN"),
  );

  const columns: string[] = [];
  const orderedGroups: ArchiveRecord[][] = [];
  const maxGroups = MAX_COLUMNS - (direct.length ? 1 : 0);
  if (names.length > maxGroups) {
    for (const name of names.slice(0, maxGroups - 1)) {
      columns.push(name);
      orderedGroups.push(groups.get(name)!);
    }
    columns.push("其它档案");
    orderedGroups.push(
      names
        .slice(maxGroups - 1)
        .flatMap((name) => groups.get(name)!),
    );
  } else {
    for (const name of names) {
      columns.push(name);
      orderedGroups.push(groups.get(name)!);
    }
  }
  if (direct.length) {
    columns.push("本层档案");
    orderedGroups.push(direct);
  }

  const view: ArchiveRecord[] = [];
  let seq = 1;
  for (const list of orderedGroups) {
    const columnName = columns[orderedGroups.indexOf(list)];
    for (const record of [...list].sort((a, b) =>
      a.path.localeCompare(b.path, "zh-CN"),
    )) {
      // 10-10 快照遗留 bug：seq 从未自增 → 全部记录 id 都是 X-001（内容面首次可见才暴露）。
      record.id = `X-${String(seq++).padStart(3, "0")}`;
      record.category = columnName;
      view.push(record);
    }
  }

  records.length = 0;
  records.push(...view);
  archiveColumns.length = 0;
  archiveColumns.push(...columns);
  categories.length = 0;
  categories.push("全部档案", ...columns);
}

export function columnFiles(lane: number) {
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === archiveColumns[lane])
    .map(({ index }) => index);
}
export function fileLocation(index: number) {
  const record = records[index];
  if (!record) return { lane: 0, row: 12, slot: 12 };
  const lane = archiveColumns.indexOf(record.category);
  const row = 12 + columnFiles(lane).indexOf(index);
  return { lane, row, slot: lane * 32 + row };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / 32));
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
