/**
 * Obsidian plugin stub: the terminal always runs as a normal (non-wallpaper)
 * surface inside an iframe, so every wallpaper capability is hard-off.
 */
export const isWallpaper = false;

export type WallpaperProperties = Record<string, { value: unknown }>;

export const wallpaperHost = (): {
  properties: WallpaperProperties;
  paused: boolean;
} | undefined => undefined;

export function wallpaperFrame(ms: number) {
  void ms;
  return true;
}
