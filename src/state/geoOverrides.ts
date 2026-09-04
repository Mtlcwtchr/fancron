/**
 * География по эпохам.
 *
 * Базовая карта — одна, а поверх неё эпохи накладывают точечные правки:
 * «с 300 года этот залив затоплен», «с -500 здесь пустыня». Оверрайды
 * накапливаются от древних эпох к текущей, ровно как принадлежность регионов,
 * поэтому история остаётся обратимой и компактной: хранятся только отличия.
 */
import { snapshotAt, toNumericDate } from './time';
import type { CellFeature, CellOverride, CellProperties, Snapshot, World } from './types';
import { layerRevision } from './world';

const cache = new Map<string, { revision: number; value: Map<string, CellOverride> }>();
const CACHE_LIMIT = 12;

/** Есть ли в мире гео-правки вообще (от этого зависят ключи кэшей слоёв). */
export function hasGeoOverrides(world: World): boolean {
  return world.timeline.snapshots.some((snapshot) => {
    const geo = snapshot.geo;
    return Boolean(geo) && Object.keys(geo!).length > 0;
  });
}

/** Кусок ключа кэша: пока правок нет, слои не зависят от времени. */
export function geoVariant(world: World, time: number): string {
  if (!hasGeoOverrides(world)) return '';
  return snapshotAt(world.timeline.snapshots, time)?.id ?? 'base';
}

/**
 * Пересчитать правки без кэша. Нужно внутри одной правки мира: несколько
 * проходов подряд (например, обрезка краёв) должны видеть свои же изменения,
 * а ревизия мира между ними ещё не сменилась.
 */
export function computeOverridesAt(world: World, time: number): Map<string, CellOverride> {
  const active = snapshotAt(world.timeline.snapshots, time);
  const value = new Map<string, CellOverride>();
  if (!active || !hasGeoOverrides(world)) return value;
  const sorted = [...world.timeline.snapshots].sort(
    (a, b) => toNumericDate(a.date) - toNumericDate(b.date),
  );
  const upto = sorted.findIndex((snapshot) => snapshot.id === active.id);
  for (let i = 0; i <= upto; i++) {
    const geo = sorted[i].geo;
    if (!geo) continue;
    for (const [cellId, patch] of Object.entries(geo)) {
      value.set(cellId, { ...value.get(cellId), ...patch });
    }
  }
  return value;
}

/** Накопленные правки на момент времени: ячейка -> изменённые атрибуты (с кэшем). */
export function overridesAt(world: World, time: number): Map<string, CellOverride> {
  const active = snapshotAt(world.timeline.snapshots, time);
  const key = `geo|${active?.id ?? 'base'}`;
  const revision = layerRevision('geo');
  const cached = cache.get(key);
  if (cached && cached.revision === revision) return cached.value;

  const value = computeOverridesAt(world, time);

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { revision, value });
  return value;
}

/** Свойства ячейки с учётом правок эпохи. */
export function effectiveProperties(
  feature: CellFeature,
  overrides: Map<string, CellOverride>,
): CellProperties {
  const patch = overrides.get(feature.properties.id);
  return patch ? { ...feature.properties, ...patch } : feature.properties;
}

export function effectiveHeight(feature: CellFeature, overrides: Map<string, CellOverride>): number {
  const patch = overrides.get(feature.properties.id);
  return Number(patch?.height ?? feature.properties.height ?? 0);
}

/** Регион ячейки на момент времени: база плюс правки эпох. */
export function effectiveRegionId(
  feature: CellFeature,
  overrides: Map<string, CellOverride>,
): string | undefined {
  const patch = overrides.get(feature.properties.id)?.regionId;
  // пустая строка — явное «с этой эпохи ячейка вне регионов», а не «нет правки»
  if (patch !== undefined) return patch === '' ? undefined : patch;
  return feature.properties.regionId;
}

/** Сколько ячеек у каждого региона на этот момент — регионы живут во времени. */
export function regionCellCounts(world: World, time: number): Map<string, number> {
  const overrides = overridesAt(world, time);
  const counts = new Map<string, number>();
  for (const feature of world.cells.features) {
    const regionId = effectiveRegionId(feature, overrides);
    if (!regionId) continue;
    counts.set(regionId, (counts.get(regionId) ?? 0) + 1);
  }
  return counts;
}

/** Записать правку в эпоху. Мутирует переданный snapshot. */
export function writeOverride(snapshot: Snapshot, cellId: string, patch: CellOverride): void {
  if (!snapshot.geo) snapshot.geo = {};
  snapshot.geo[cellId] = { ...snapshot.geo[cellId], ...patch };
}

export function countOverrides(snapshot: Snapshot | null | undefined): number {
  return snapshot?.geo ? Object.keys(snapshot.geo).length : 0;
}
