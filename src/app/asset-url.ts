/**
 * Obsidian plugin runtime: all resources live in the plugin's assets folder
 * and are served through the injected base URL (app://local/.../assets/).
 */
declare global {
  interface Window {
    RHINE_BASE_URL?: string;
    /** 宿主注入的仓库名（app.vault.getName()），展廊名自适应的来源。 */
    RHINE_VAULT?: string;
  }
}

export const assetUrl = (path: string) => {
  const base = window.RHINE_BASE_URL ?? "/";
  return `${base}${path.replace(/^\//, "")}`;
};
