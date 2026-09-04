/**
 * Поле ветров: широтные полосы, но с плавным переходом между ними.
 *
 * В Azgaar ветер задан шестью полосами (пассаты, западные, полярные), и если
 * брать полосу «как есть», направление скачет ступенькой на границе. Для
 * симуляции влаги это создаёт резкие разрывы осадков, а для картинки —
 * ломаные стрелки вместо потоков. Поэтому угол интерполируется по короткой
 * дуге между соседними полосами.
 */

/** Кратчайшая интерполяция углов в градусах. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  return from + delta * t;
}

export interface WindSampleOptions {
  /** широта, играющая роль экватора: климатические пояса сдвигаются вместе с ней */
  equatorLat?: number;
}

/**
 * Направление ветра для широты в градусах (0 — на север, по часовой),
 * с учётом смещения экватора и плавного перехода между полосами.
 */
export function windAngleAt(bands: number[], lat: number, options: WindSampleOptions = {}): number | null {
  if (!bands || bands.length === 0) return null;
  const equator = options.equatorLat ?? 0;
  const shifted = lat - equator;
  const normalized = Math.min(1, Math.max(0, (90 - shifted) / 180));

  const position = normalized * bands.length - 0.5;
  const low = Math.floor(position);
  const t = position - low;
  const a = bands[Math.min(bands.length - 1, Math.max(0, low))];
  const b = bands[Math.min(bands.length - 1, Math.max(0, low + 1))];
  return lerpAngle(a, b, Math.min(1, Math.max(0, t)));
}

/** Единичный вектор направления ветра в координатах карты (x — на восток, y — на север). */
export function windVectorAt(
  bands: number[],
  lat: number,
  options: WindSampleOptions = {},
): [number, number] | null {
  const angle = windAngleAt(bands, lat, options);
  if (angle === null) return null;
  const radians = (angle * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians)];
}
