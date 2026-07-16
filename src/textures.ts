import * as THREE from "three";

// A soft round sprite: a radial gradient from `inner` (centre) through `mid`
// (at `midStop`) to a fully-transparent `outer` edge, painted on a `size`² canvas.
// Shared by every particle/trail/spark system — the RGB of the transparent outer
// stop still tints the fade, so each caller passes its own to keep its exact look.
export function softDot(
  inner: string,
  mid: string,
  outer = "rgba(0,0,0,0)",
  midStop = 0.45,
  size = 64,
): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(midStop, mid);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}
