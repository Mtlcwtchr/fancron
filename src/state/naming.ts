/**
 * Имена во времени.
 *
 * У государств, регионов и справочников может быть история переименований
 * (`names`) и переходов (`succeededBy`). Карта, легенда и подписи всегда
 * показывают то, что действовало на текущий момент шкалы времени:
 * «Первая Империя» до -300 и «Солмарская лига» после, без перерисовки границ.
 */
import { toNumericDate } from './time';
import type { DictEntry, NameChange, StateDef, Succession, World } from './types';

export type DictKindKey = 'cultures' | 'religions' | 'languages' | 'biomes';

interface Nameable {
  id: string;
  name?: string;
  names?: NameChange[];
}

interface Successive {
  id: string;
  succeededBy?: Succession[];
}

/** Имя, действующее на момент `time`. */
export function nameAt(entity: Nameable | undefined, time: number): string {
  if (!entity) return '';
  let result = entity.name ?? entity.id;
  if (!entity.names || entity.names.length === 0) return result;
  const sorted = [...entity.names].sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));
  for (const change of sorted) {
    if (toNumericDate(change.date) <= time) result = change.name;
    else break;
  }
  return result;
}

/** Пройти по цепочке переходов и вернуть id сущности, актуальной на момент `time`. */
export function resolveSuccession<T extends Successive>(
  entries: T[],
  id: string | undefined,
  time: number,
  depth = 0,
): string | undefined {
  if (!id || depth > 16) return id;
  const entry = entries.find((item) => item.id === id);
  if (!entry?.succeededBy || entry.succeededBy.length === 0) return id;
  const sorted = [...entry.succeededBy].sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));
  let target: string | undefined;
  for (const step of sorted) {
    if (toNumericDate(step.date) <= time) target = step.toId;
    else break;
  }
  if (!target || target === id) return id;
  return resolveSuccession(entries, target, time, depth + 1);
}

/** Государство с учётом переходов, плюс имя на этот момент. */
export function stateAt(world: World, id: string | undefined, time: number): StateDef | undefined {
  const resolvedId = resolveSuccession(world.timeline.states, id, time);
  const state = world.timeline.states.find((item) => item.id === resolvedId);
  if (!state) return undefined;
  return { ...state, name: nameAt(state, time) };
}

export function resolveStateId(world: World, id: string | undefined, time: number): string | undefined {
  return resolveSuccession(world.timeline.states, id, time);
}

/** Запись справочника с учётом переходов и переименований. */
export function dictEntryAt(
  world: World,
  kind: DictKindKey,
  id: string | undefined,
  time: number,
): DictEntry | undefined {
  const entries = world.dictionaries[kind];
  const resolvedId = resolveSuccession(entries, id, time);
  const entry = entries.find((item) => item.id === resolvedId);
  if (!entry) return undefined;
  return { ...entry, name: nameAt(entry, time) };
}

export function resolveDictId(
  world: World,
  kind: DictKindKey,
  id: string | undefined,
  time: number,
): string | undefined {
  return resolveSuccession(world.dictionaries[kind], id, time);
}

export function regionNameAt(world: World, regionId: string, time: number): string {
  const feature = world.regions.features.find((item) => item.properties.id === regionId);
  if (!feature) return regionId;
  return nameAt({ id: regionId, name: feature.properties.name, names: feature.properties.names }, time);
}

/** Есть ли в мире переходы — от этого зависит, нужно ли пересчитывать слои при смене времени. */
export function hasSuccessions(world: World): boolean {
  const check = (items: Successive[]): boolean => items.some((item) => (item.succeededBy?.length ?? 0) > 0);
  return (
    check(world.timeline.states) ||
    check(world.dictionaries.cultures) ||
    check(world.dictionaries.religions) ||
    check(world.dictionaries.languages)
  );
}

/**
 * Существует ли точка на момент времени. Города и метки живут не вечно:
 * основан в таком-то году, разрушен в таком-то — на карте прошлого его быть
 * не должно, а в будущем он уже руины.
 */
export function pointVisibleAt(
  point: { from?: string; to?: string },
  time: number,
): boolean {
  if (point.from !== undefined && point.from !== '' && time < toNumericDate(point.from)) return false;
  if (point.to !== undefined && point.to !== '' && time >= toNumericDate(point.to)) return false;
  return true;
}

/** Отсортированная история переименований (для UI). */
export function sortedNames(entity: Nameable | undefined): NameChange[] {
  if (!entity?.names) return [];
  return [...entity.names].sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));
}
