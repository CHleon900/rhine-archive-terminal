import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Two profiles: default = public OSS build (Noto Sans SC, OFL); --personal = MiSans.
// The personal profile expects the font files to be supplied locally; they are not in this repo.
const args = process.argv.slice(2);
const OSS = !args.includes("--personal");
const outArg = args.find((a) => a.startsWith("--out="));
const outDir = outArg
  ? path.resolve(outArg.slice("--out=".length))
  : path.join(here, OSS ? "release/rhine-archive-terminal" : "release/personal/rhine-archive-terminal");
const fontCssPath = path.join(here, OSS ? "src/app/fonts-oss.css" : "src/app/fonts.css");
writeFileSync(path.join(here, "src/app/fonts-active.css"), readFileSync(fontCssPath, "utf8"));
const rhinePublic = process.env.RHINE_LAB_PUBLIC || "D:/hanakoplace/RhineLabUI/public";
const localAssets = path.join(here, "media/assets");

// 1. Terminal app bundle (runs inside the iframe)
await build({
  entryPoints: [path.join(here, "src/app/entry.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  outfile: path.join(here, "dist/app.js"),
  minify: true,
  legalComments: "none",
  define: {
    __RHINE_NOVECENTO__: "false",
    __RHINE_FONT_NAME__: JSON.stringify(OSS ? "Noto Sans SC（SIL OFL）" : "MiSans"),
    __RHINE_FONT_LICENSE__: JSON.stringify(OSS ? "licenses/NotoSansSC-OFL.txt" : ""),
  },
  external: ["/fonts/*", "/assets/*", "/audio/*", "/icons/*", "/archives/*"],
  logLevel: "info",
});

// 2. Rewrite absolute CSS asset urls to be relative (resolved via <base href>)
const preferNoto = (text) => text
  .replaceAll('"MiSans","Noto Sans SC"', '"Noto Sans SC","MiSans"')
  .replaceAll("MiSans,Noto Sans SC", "Noto Sans SC,MiSans")
  .replaceAll('"MiSans", "Noto Sans SC"', '"Noto Sans SC", "MiSans"')
  .replaceAll("'MiSans','Noto Sans SC'", "'Noto Sans SC','MiSans'")
  .replaceAll("MiSans, 'Noto Sans SC'", "Noto Sans SC, 'MiSans'")
  .replaceAll("MiSans, Noto Sans SC", "Noto Sans SC, MiSans");
const cssPath = path.join(here, "dist/app.css");
let css = readFileSync(cssPath, "utf8").replace(/url\((["']?)\//g, "url($1");

// 3. Obsidian plugin bundle
await build({
  entryPoints: [path.join(here, "src/plugin-main.ts")],
  bundle: true,
  format: "cjs",
  target: ["es2022"],
  platform: "browser",
  external: ["obsidian"],
  outfile: path.join(outDir, "main.js"),
  minify: true,
  legalComments: "none",
  footer: { js: "module.exports = module.exports.default || module.exports;" },
  logLevel: "info",
});

// 4. Assemble the plugin directory
mkdirSync(outDir, { recursive: true });
if (OSS) css = preferNoto(css);
writeFileSync(path.join(outDir, "app.css"), css);
let appJs = readFileSync(path.join(here, "dist/app.js"), "utf8");
if (OSS) appJs = preferNoto(appJs);
writeFileSync(path.join(outDir, "app.js"), appJs);
// Doc view styles (host side) + selected webfont declarations, both resolved
// relative to the plugin folder via app://local.
const docCss =
  readFileSync(path.join(here, "src/native-skin.css"), "utf8") +
  "\n" +
  readFileSync(path.join(here, "src/doc-view.css"), "utf8");
const fontCss = existsSync(fontCssPath)
  ? readFileSync(fontCssPath, "utf8").replace(/url\((["']?)\//g, "url($1./")
  : "";
writeFileSync(path.join(outDir, "styles.css"), docCss + "\n" + fontCss);
writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify(
    {
      id: "rhine-archive-terminal",
      name: "Rhine Archive Terminal",
      version: "1.0.0",
      minAppVersion: "1.5.0",
      description: "莱茵档案终端：以档案阵列展示 Obsidian 库中的 Markdown 笔记（3D 档案阵列 + 解密揭示，只读）。",
      author: "CL",
      isDesktopOnly: true,
    },
    null,
    2,
  ),
);

// 5. Static assets from the original project (GLB / audio / fonts / licenses)
const assetsDir = path.join(outDir, "assets-src");
if (existsSync(assetsDir)) rmSync(assetsDir, { recursive: true, force: true });
const localAudio = path.join(here, "media/audio");
const localFonts = path.join(here, "media/fonts");
const fontAssetDir = OSS ? localFonts : path.join(rhinePublic, "fonts");
for (const dir of ["assets", "audio", "fonts", "licenses"]) {
  const src =
    dir === "assets" && existsSync(localAssets)
      ? localAssets
      : dir === "audio" && existsSync(localAudio)
        ? localAudio
        : dir === "fonts"
          ? fontAssetDir
          : path.join(rhinePublic, dir);
  if (!existsSync(src)) {
    if (dir === "fonts" || dir === "assets") {
      throw new Error(`Missing required asset directory: ${src}`);
    }
    continue;
  }
  const dest = path.join(outDir, dir);
  if (dir === "audio" || dir === "fonts") rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}
// OFL / attribution files that travel with the bundled Noto font (OSS only).
const localLicenses = path.join(here, "licenses");
if (OSS && existsSync(localLicenses)) {
  mkdirSync(path.join(outDir, "licenses"), { recursive: true });
  cpSync(localLicenses, path.join(outDir, "licenses"), { recursive: true });
}
// archives txt exports are replaced by "open in Obsidian" — skipped.

// 6. home page (home-i): ship with plugin, inject iframe bridge
const homeSrc = path.join(here, "preview/home-i/index.html");
const vendorSrc = path.join(here, "vendor/hyalite.js");
if (existsSync(homeSrc)) {
  let html = readFileSync(homeSrc, "utf8");
  const bridge = '<script>/*RHINE_HOME_BRIDGE*/try{if(window.parent!==window){window.__RHINE_EMBED__=true;try{dispatchEvent(new Event("resize"));}catch(e){};var __curDir=function(){try{var c=(typeof CAB!=="undefined")?CAB[cur]:null;return (c&&c.dir)||"";}catch(e){return "";}};var __send=function(){try{parent.postMessage({source:"rhine-home",type:"enter",dir:__curDir()},"*");}catch(e){}};window.__rhineHomeDir=__curDir;window.openEnter=function(){var h=document.getElementById("enter-hint");if(h)h.textContent="正在打开档案终端 …";__send();};}}catch(e){}</script>';
  const cut = html.lastIndexOf("</body>");
  if (cut > 0 && !html.includes("RHINE_HOME_BRIDGE")) html = html.slice(0, cut) + bridge + html.slice(cut);
  mkdirSync(path.join(outDir, "web/home-i"), { recursive: true });
  writeFileSync(path.join(outDir, "web/home-i/index.html"), html);
}
if (existsSync(vendorSrc)) {
  mkdirSync(path.join(outDir, "vendor"), { recursive: true });
  cpSync(vendorSrc, path.join(outDir, "vendor/hyalite.js"));
}
console.log(`Build complete (${OSS ? "OSS / Noto" : "personal / MiSans"}) ->`, outDir);
