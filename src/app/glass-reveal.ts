// A feathered clearing front travels from the top to the bottom of the cover.
// Progress endpoints are wholly frosted / wholly clear, including the rim.
const FEATHER = 0.12;
export const FROSTED_ROUGHNESS = 0.42;
// 全清端 0.025→0.010（2026-10-16 用户裁定：详情态降遮罩层存在感、保内容页与结构件）：
// 抽出卡盖板的残余磨砂是「蒙一层」观感的载体；阵列卡（0.21~0.28 磨砂端）不受影响。
export const CLEAR_ROUGHNESS = 0.01;
const FROST_SPAN = 0.016;

// Three's default mip rule grows blur relative to an object as the viewport
// shrinks. Bound the frosted footprint to 1.6% of the projected cover height.
export function frostedTransmissionLod(
  panelPixels: number,
  textureWidth: number,
  roughness: number,
  quality = 1,
  ior = 1.46,
) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const strength = clamp((roughness - CLEAR_ROUGHNESS) / (FROSTED_ROUGHNESS - CLEAR_ROUGHNESS));
  const native = Math.log2(textureWidth) * roughness * clamp(ior * 2 - 2);
  const clearLod = Math.log2(textureWidth) * CLEAR_ROUGHNESS * clamp(ior * 2 - 2);
  const bounded = Math.log2(Math.max(2 ** clearLod, panelPixels * FROST_SPAN * Math.pow(strength, 1.15)));
  return native + (Math.min(native, bounded) - native) * quality;
}
export const frostedTransmissionGLSL = `
float archiveTransmissionLod(float roughness, float ior, vec2 samplerSize) {
  float nativeLod = log2(samplerSize.x) * roughness * clamp(ior * 2.0 - 2.0, 0.0, 1.0);
  float strength = clamp((roughness - ${CLEAR_ROUGHNESS}) / ${FROSTED_ROUGHNESS - CLEAR_ROUGHNESS}, 0.0, 1.0);
  float panelPixels = length(vArchiveProjectedAxis * samplerSize);
  float clearLod = log2(samplerSize.x) * ${CLEAR_ROUGHNESS} * clamp(ior * 2.0 - 2.0, 0.0, 1.0);
  float boundedLod = log2(max(exp2(clearLod), panelPixels * ${FROST_SPAN} * pow(strength, 1.15)));
  return mix(nativeLod, min(nativeLod, boundedLod), archiveQuality);
}`;
export function glassRevealAtHeight(progress: number, height: number) {
  const edge = 1 - (1 + 2 * FEATHER) * Math.max(0, Math.min(1, progress));
  const x = Math.max(
    0,
    Math.min(1, (Math.max(0, Math.min(1, height)) - edge) / (2 * FEATHER)),
  );
  return x * x * (3 - 2 * x);
}
export const glassRevealGLSL = `
float glassRevealAtHeight(float progress, float height) {
  float edge = 1.0 - ${1 + 2 * FEATHER} * clamp(progress, 0.0, 1.0);
  return smoothstep(edge, edge + ${2 * FEATHER}, clamp(height, 0.0, 1.0));
}`;
