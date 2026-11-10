/**
 * Viewer zoom/pan model. The photograph is drawn "contain"-fitted in the stage at scale 1; zoom multiplies that fitted size.
 * x/y are the pan offset in stage pixels. Pure functions so they can be tested without a DOM.
 */
export interface ZoomState { scale: number; x: number; y: number }
export interface Size { w: number; h: number }
export const FIT: ZoomState = { scale: 1, x: 0, y: 0 };
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const DOUBLE_CLICK_SCALE = 2.5;

/** Size of the photograph as drawn at scale 1 (object-fit: contain). */
export function fittedSize(stage: Size, image: Size): Size {
  if (stage.w <= 0 || stage.h <= 0 || image.w <= 0 || image.h <= 0) return { w: 0, h: 0 };
  const k = Math.min(stage.w / image.w, stage.h / image.h);
  return { w: image.w * k, h: image.h * k };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keeps the photograph covering the stage on any axis where it is larger than the stage, and centred where it is smaller. */
export function clampZoom(z: ZoomState, stage: Size, image: Size): ZoomState {
  const scale = clamp(z.scale, MIN_SCALE, MAX_SCALE);
  if (scale === MIN_SCALE) return FIT;
  const f = fittedSize(stage, image);
  const maxX = Math.max(0, (f.w * scale - stage.w) / 2), maxY = Math.max(0, (f.h * scale - stage.h) / 2);
  return { scale, x: clamp(z.x, -maxX, maxX), y: clamp(z.y, -maxY, maxY) };
}

/** Zoom by `factor` keeping the point under the pointer fixed. `point` is relative to the stage centre. */
export function zoomAt(z: ZoomState, factor: number, point: { x: number; y: number }, stage: Size, image: Size): ZoomState {
  const scale = clamp(z.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / z.scale;
  return clampZoom({ scale, x: point.x - (point.x - z.x) * k, y: point.y - (point.y - z.y) * k }, stage, image);
}

export const panBy = (z: ZoomState, dx: number, dy: number, stage: Size, image: Size): ZoomState => clampZoom({ ...z, x: z.x + dx, y: z.y + dy }, stage, image);

/** Click-to-zoom toggle: fit → 2.5× at the pointer, anything else → fit. */
export const toggleZoom = (z: ZoomState, point: { x: number; y: number }, stage: Size, image: Size): ZoomState =>
  z.scale > MIN_SCALE ? FIT : zoomAt(z, DOUBLE_CLICK_SCALE, point, stage, image);

/** Wheel / trackpad: smooth exponential zoom. */
export const wheelFactor = (deltaY: number, ctrl: boolean): number => Math.exp(-deltaY * (ctrl ? 0.01 : 0.0022));
