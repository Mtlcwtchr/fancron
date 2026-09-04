/**
 * Кисти: правка атрибутов ячеек и рельефа.
 *
 * Ключевая деталь про политику. Модель ТЗ хранит историю как «регион -> государство»
 * по эпохам, а рисовать хочется свободно, по ячейкам. Поэтому кисть государства при
 * необходимости РАЗРЕЗАЕТ регион: закрашенные ячейки выделяются в новый регион, который
 * наследует владельцев старого во всех прочих эпохах, а в текущей эпохе достаётся
 * выбранному государству. Границы получаются произвольной формы, а модель остаётся
 * компактной и обратимой.
 */
import type { Position } from 'geojson';
import { uid } from '../util/id';
import { heightExtent, seaLevelOf } from '../map/layers';
import { biomeForConditions } from '../util/biome';
import { computeOverridesAt, effectiveRegionId, writeOverride } from './geoOverrides';
import { topologyOf } from './topology';
import { snapshotAt, toNumericDate } from './time';
import type { CellProperties, Snapshot, World } from './types';
import type { HeightOp, PaintTarget } from './ui';
import { mutateWorld, regionOwnershipAt } from './world';

/* ------------------------------------------------------------------ */
/* выбор ячеек                                                         */
/* ------------------------------------------------------------------ */

/** Ячейки, чьи центры попали в круг радиуса `radius` (в градусах). */
export function cellsInRadius(world: World, lon: number, lat: number, radius: number): string[] {
  const topology = topologyOf(world);
  const found: string[] = [];
  const radiusSquared = radius * radius;

  topology.tree.visit((node, x0, y0, x1, y1) => {
    if (x0 > lon + radius || x1 < lon - radius || y0 > lat + radius || y1 < lat - radius) return true;
    if (!('length' in node)) {
      let leaf: typeof node | undefined = node;
      while (leaf) {
        const point = leaf.data;
        if ((point.lon - lon) ** 2 + (point.lat - lat) ** 2 <= radiusSquared) found.push(point.id);
        leaf = leaf.next;
      }
    }
    return false;
  });

  if (found.length === 0) {
    const nearest = topology.tree.find(lon, lat, radius * 3);
    if (nearest) found.push(nearest.id);
  }
  return found;
}

/** Ячейка под точкой (для выбора и подсказок). */
export function cellAt(world: World, lon: number, lat: number): string | null {
  const topology = topologyOf(world);
  return topology.tree.find(lon, lat)?.id ?? null;
}

function cellCentroid(world: World, id: string): [number, number] | null {
  const point = topologyOf(world).pointById.get(id);
  return point ? [point.lon, point.lat] : null;
}

/** Слои данных, которые устареют от кисти. */
const AFFECTED: Record<string, string[]> = {
  biome: ['biomes'],
  cultureId: ['cultures'],
  religionId: ['religions'],
  languageId: ['languages'],
  regionId: ['regions', 'states'],
  stateId: ['states', 'regions'],
};

/** Правки в эпоху задевают ещё и кэш гео-оверрайдов. */
function affectedFor(target: PaintTarget, epoch: boolean | undefined): string[] | undefined {
  const base = AFFECTED[target] ?? [];
  if (!epoch) return base.length > 0 ? base : undefined;
  return [...new Set([...base, 'geo', 'regions', 'states'])];
}

/* ------------------------------------------------------------------ */
/* сессия мазка                                                        */
/* ------------------------------------------------------------------ */

/**
 * За один мазок кисти государства регион разрезается один раз, а не на каждое
 * событие мыши: ключ — «родительский регион + государство + эпоха».
 */
let splitSession = new Map<string, string>();

export function beginPaintSession(): void {
  splitSession = new Map();
}

export function endPaintSession(): void {
  splitSession = new Map();
  mutateWorld((world) => mergeAutoRegions(world), ['states', 'regions']);
}

/** Подпись истории региона: владельцы по всем эпохам + базовая принадлежность. */
function historySignature(world: World, regionId: string): string {
  const parts = [
    world.regions.features.find((feature) => feature.properties.id === regionId)?.properties.stateId ?? '',
  ];
  for (const snapshot of world.timeline.snapshots) {
    parts.push(`${snapshot.id}=${snapshot.regionState[regionId] ?? ''}`);
  }
  return parts.join('|');
}

/**
 * Склейка регионов, созданных кистью (auto: true), с одинаковой историей владения.
 * Пользовательские и импортированные регионы не трогаем — их имена важны.
 */
function mergeAutoRegions(world: World): void {
  const auto = world.regions.features.filter((feature) => feature.properties.auto === true);
  if (auto.length < 2) return;

  const groups = new Map<string, string[]>();
  for (const feature of auto) {
    const key = historySignature(world, feature.properties.id);
    const bucket = groups.get(key);
    if (bucket) bucket.push(feature.properties.id);
    else groups.set(key, [feature.properties.id]);
  }

  const remap = new Map<string, string>();
  const removed = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const [keep, ...rest] = ids;
    for (const id of rest) {
      remap.set(id, keep);
      removed.add(id);
    }
  }
  if (remap.size === 0) return;

  for (const feature of world.cells.features) {
    const regionId = feature.properties.regionId;
    if (regionId && remap.has(regionId)) feature.properties.regionId = remap.get(regionId);
  }
  world.regions.features = world.regions.features.filter((feature) => !removed.has(feature.properties.id));
  for (const snapshot of world.timeline.snapshots) {
    for (const id of removed) delete snapshot.regionState[id];
  }
}

/* ------------------------------------------------------------------ */
/* атрибуты                                                            */
/* ------------------------------------------------------------------ */

function editableSnapshot(world: World, time: number): Snapshot {
  const existing = snapshotAt(world.timeline.snapshots, time);
  if (existing) return existing;
  const snapshot: Snapshot = {
    id: uid('snap'),
    date: String(Math.round(time)),
    label: 'Начальная эпоха',
    regionState: {},
  };
  world.timeline.snapshots.push(snapshot);
  return snapshot;
}

function regionName(world: World, regionId: string | undefined): string {
  if (!regionId) return 'Новые земли';
  return world.regions.features.find((feature) => feature.properties.id === regionId)?.properties.name ?? regionId;
}

function ensureRegion(world: World, id: string, name: string, stateId?: string, auto = false): void {
  if (world.regions.features.some((feature) => feature.properties.id === id)) return;
  world.regions.features.push({
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [] as Position[][][] },
    properties: auto ? { id, name, stateId, auto: true } : { id, name, stateId },
  });
}

/**
 * Закрасить государством в текущей эпохе, не трогая базовую карту.
 *
 * Границы регионов не статичны: закрашенные ячейки переезжают в «эпохальный»
 * регион этого государства через оверрайд `snapshot.geo[cellId].regionId`.
 * Прошлые эпохи остаются как были, последующие наследуют — то есть граница
 * действует «с этой даты и дальше», пока её не переопределят снова.
 */
function paintStateInEpoch(world: World, cellIds: string[], stateId: string | null, time: number): void {
  const snapshot = editableSnapshot(world, time);
  const topology = topologyOf(world);
  const overrides = computeOverridesAt(world, time);
  const owner = stateId ?? '';

  const sessionKey = `epoch|${owner}|${snapshot.id}`;
  let regionId = splitSession.get(sessionKey);

  if (!regionId) {
    // регион этой эпохи для этого владельца мог быть создан предыдущим мазком
    const existing = world.regions.features.find(
      (feature) =>
        feature.properties.auto === true &&
        feature.properties.epoch === snapshot.id &&
        (snapshot.regionState[feature.properties.id] ?? '') === owner,
    );
    regionId = existing?.properties.id;
  }

  if (!regionId) {
    regionId = uid('region');
    const stateName = world.timeline.states.find((item) => item.id === stateId)?.name;
    const epochName = snapshot.label ?? snapshot.date;
    world.regions.features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [] },
      properties: {
        id: regionId,
        name: `${stateName ?? 'Ничьё'} · ${epochName}`,
        auto: true,
        epoch: snapshot.id,
      },
    });
    snapshot.regionState[regionId] = owner;
  }
  splitSession.set(sessionKey, regionId);

  for (const cellId of cellIds) {
    if (!topology.byId.has(cellId)) continue;
    if (effectiveRegionId(topology.byId.get(cellId)!, overrides) === regionId) continue;
    writeOverride(snapshot, cellId, { regionId });
  }
}

/**
 * Закрасить государством: при необходимости разрезая регионы (см. комментарий модуля).
 */
function paintState(world: World, cellIds: string[], stateId: string | null, time: number): void {
  const snapshot = editableSnapshot(world, time);
  const topology = topologyOf(world);
  const owner = stateId ?? '';

  const byRegion = new Map<string | undefined, string[]>();
  for (const cellId of cellIds) {
    const cell = topology.byId.get(cellId);
    if (!cell) continue;
    const regionId = cell.properties.regionId;
    if (regionId && snapshot.regionState[regionId] === owner) continue; // уже нужный владелец
    const bucket = byRegion.get(regionId);
    if (bucket) bucket.push(cellId);
    else byRegion.set(regionId, [cellId]);
  }
  if (byRegion.size === 0) return;

  // сколько всего ячеек в каждом задетом регионе
  const totals = new Map<string, number>();
  for (const feature of world.cells.features) {
    const regionId = feature.properties.regionId;
    if (!regionId || !byRegion.has(regionId)) continue;
    totals.set(regionId, (totals.get(regionId) ?? 0) + 1);
  }

  for (const [regionId, cells] of byRegion) {
    // регион закрашен целиком — просто меняем владельца, история остальных эпох не страдает
    if (regionId && cells.length >= (totals.get(regionId) ?? 0)) {
      snapshot.regionState[regionId] = owner;
      continue;
    }

    const sessionKey = `${regionId ?? '∅'}|${owner}|${snapshot.id}`;
    let targetId = splitSession.get(sessionKey);

    if (!targetId) {
      targetId = uid('region');
      const stateName = world.timeline.states.find((item) => item.id === stateId)?.name;
      ensureRegion(
        world,
        targetId,
        regionId ? `${regionName(world, regionId)} → ${stateName ?? 'ничьё'}` : `Новые земли${stateName ? `: ${stateName}` : ''}`,
        regionId
          ? world.regions.features.find((feature) => feature.properties.id === regionId)?.properties.stateId
          : undefined,
        true,
      );
      // новый регион наследует историю старого, чтобы прошлые эпохи не «поплыли»
      if (regionId) {
        for (const item of world.timeline.snapshots) {
          const previous = item.regionState[regionId];
          if (previous !== undefined) item.regionState[targetId] = previous;
        }
      }
      snapshot.regionState[targetId] = owner;
      splitSession.set(sessionKey, targetId);
    }

    for (const cellId of cells) {
      const cell = topology.byId.get(cellId);
      if (cell) cell.properties.regionId = targetId;
    }
  }
}

export interface PaintOptions {
  target: PaintTarget;
  value: string;
  time: number;
  /** писать правку не в базовую карту, а в текущую эпоху (гео-оверрайд) */
  epoch?: boolean;
}

/** Применить кисть атрибутов к набору ячеек. Вызывается внутри мазка (без записи в историю). */
export function applyPaint(cellIds: string[], options: PaintOptions): void {
  if (cellIds.length === 0) return;
  const affects = affectedFor(options.target, options.epoch);
  mutateWorld((world) => {
    if (options.target === 'stateId') {
      const stateId = options.value && options.value !== 'none' ? options.value : null;
      if (options.epoch) paintStateInEpoch(world, cellIds, stateId, options.time);
      else paintState(world, cellIds, stateId, options.time);
      return;
    }

    const topology = topologyOf(world);
    if (options.target === 'regionId') {
      const regionId = options.value;
      // пустое значение — «без региона»: ячейка перестаёт принадлежать какому-либо
      // региону, а значит и государству
      if (regionId) ensureRegion(world, regionId, regionName(world, regionId));

      if (options.epoch) {
        // граница региона меняется только с этой эпохи
        const snapshot = editableSnapshot(world, options.time);
        for (const cellId of cellIds) {
          if (topology.byId.has(cellId)) writeOverride(snapshot, cellId, { regionId });
        }
        return;
      }
      for (const cellId of cellIds) {
        const cell = topology.byId.get(cellId);
        if (!cell) continue;
        if (regionId) cell.properties.regionId = regionId;
        else delete cell.properties.regionId;
      }
      return;
    }

    const key = options.target as keyof CellProperties;

    // правка эпохи: базовая карта не трогается, отличие пишется в snapshot
    if (options.epoch) {
      const snapshot = editableSnapshot(world, options.time);
      for (const cellId of cellIds) {
        if (!topology.byId.has(cellId)) continue;
        if (options.value === '') {
          if (snapshot.geo?.[cellId]) {
            delete (snapshot.geo[cellId] as Record<string, unknown>)[key as string];
            if (Object.keys(snapshot.geo[cellId]).length === 0) delete snapshot.geo[cellId];
          }
        } else {
          writeOverride(snapshot, cellId, { [key as string]: options.value });
        }
      }
      return;
    }

    for (const cellId of cellIds) {
      const cell = topology.byId.get(cellId);
      if (!cell) continue;
      if (options.value === '') delete cell.properties[key as string];
      else (cell.properties as Record<string, unknown>)[key as string] = options.value;
    }
  }, affects);
}

/* ------------------------------------------------------------------ */
/* рельеф                                                              */
/* ------------------------------------------------------------------ */

export interface HeightOptions {
  op: HeightOp;
  strength: number;
  center: [number, number];
  radius: number;
  time: number;
  /** писать правку в текущую эпоху, а не в базовую карту */
  epoch?: boolean;
}

/** Плавное затухание от центра кисти к краю. */
function falloff(distanceSquared: number, radiusSquared: number): number {
  if (radiusSquared <= 0) return 1;
  const t = Math.min(1, distanceSquared / radiusSquared);
  return (1 - t) * (1 - t);
}

/**
 * Кисти рельефа: поднять / опустить / выровнять / размыть / почистить береговую линию.
 * Правятся высоты ячеек; растровая сетка (если была) заменяется рельефом по ячейкам.
 */
export function applyHeightBrush(cellIds: string[], options: HeightOptions): void {
  if (cellIds.length === 0) return;
  mutateWorld((world) => {
    const topology = topologyOf(world);
    const overrides = computeOverridesAt(world, options.time);
    const snapshot = options.epoch ? editableSnapshot(world, options.time) : null;
    const sea = seaLevelOf(world);
    const zeroToHundred = sea === 20;
    const minAllowed = zeroToHundred ? 0 : -11000;
    const maxAllowed = zeroToHundred ? 100 : 9000;
    const radiusSquared = options.radius * options.radius;

    const heightOf = (id: string): number => {
      const patched = overrides.get(id)?.height;
      if (patched !== undefined) return Number(patched);
      return Number(topology.byId.get(id)?.properties.height ?? 0);
    };
    const setHeight = (id: string, value: number): void => {
      const cell = topology.byId.get(id);
      if (!cell) return;
      const height = Math.round(Math.min(maxAllowed, Math.max(minAllowed, value)) * 100) / 100;
      if (snapshot) writeOverride(snapshot, id, { height });
      else cell.properties.height = height;
    };

    const [, maxHeight] = heightExtent(world);

    // средняя высота под кистью — цель для «выровнять»
    let sum = 0;
    for (const id of cellIds) sum += heightOf(id);
    const average = sum / cellIds.length;

    for (const id of cellIds) {
      const point = topology.pointById.get(id);
      const distanceSquared = point
        ? (point.lon - options.center[0]) ** 2 + (point.lat - options.center[1]) ** 2
        : 0;
      const weight = falloff(distanceSquared, radiusSquared);
      const height = heightOf(id);

      switch (options.op) {
        case 'up':
          setHeight(id, height + options.strength * weight);
          break;
        case 'down':
          setHeight(id, height - options.strength * weight);
          break;
        case 'flatten':
          setHeight(id, height + (average - height) * weight);
          break;
        case 'blend': {
          const neighbors = topology.neighbors.get(id) ?? [];
          if (neighbors.length === 0) break;
          let neighborSum = 0;
          for (const neighborId of neighbors) neighborSum += heightOf(neighborId);
          const target = neighborSum / neighbors.length;
          setHeight(id, height + (target - height) * 0.8 * weight);
          break;
        }
        case 'coastline': {
          // подчистить берег: одинокая вода среди земли становится землёй и наоборот
          const neighbors = topology.neighbors.get(id) ?? [];
          if (neighbors.length === 0) break;
          const land = neighbors.filter((neighborId) => heightOf(neighborId) >= sea).length;
          const share = land / neighbors.length;
          const step = Math.max(1, options.strength * 0.5) * weight;
          if (height >= sea && share < 0.35) setHeight(id, sea - step);
          else if (height < sea && share > 0.65) setHeight(id, sea + step);
          break;
        }
      }
    }

    // берег сдвинулся — приводим биом в соответствие: море не остаётся сушей и наоборот
    for (const id of cellIds) {
      const cell = topology.byId.get(id);
      if (!cell) continue;
      const height = Number(cell.properties.height ?? 0);
      const lat = topology.pointById.get(id)?.lat ?? 0;
      if (height < sea) {
        if (cell.properties.biome !== 'Marine') cell.properties.biome = 'Marine';
      } else if (!cell.properties.biome || cell.properties.biome === 'Marine') {
        cell.properties.biome = biomeForConditions(height, lat, sea, Math.max(maxHeight, height));
      }
    }

    if (world.layers.heightmap) delete world.layers.heightmap;
  }, ['heightmap', 'biomes']);
}

/* ------------------------------------------------------------------ */
/* обрезка краёв политической карты                                    */
/* ------------------------------------------------------------------ */

export interface CutEdgesOptions {
  time: number;
  /** снимать принадлежность только с этой эпохи, не трогая базовую карту */
  epoch?: boolean;
  /** отпускаем ячейку, если соседей того же владельца не больше этого числа */
  maxNeighbors?: number;
  /** снимать принадлежность с воды (закрашенный мимо берега океан) */
  dropWater?: boolean;
  passes?: number;
  /** ограничить обработку этими ячейками (иначе вся карта) */
  restrictTo?: string[];
}

/**
 * «Cut edges»: убирает из политических территорий торчащие и случайные ячейки —
 * одиночные вкрапления, тонкие языки вдоль границ и закрашенную воду.
 * Ячейки не удаляются, а становятся ничьими в текущей эпохе (через то же
 * разрезание регионов, поэтому прошлые эпохи не меняются).
 *
 * Возвращает число отпущенных ячеек. Мутирует переданный мир — вызывать внутри commit().
 */
export function cutEdgesIn(world: World, options: CutEdgesOptions): number {
  const topology = topologyOf(world);
  const sea = seaLevelOf(world);
  const overrides = computeOverridesAt(world, options.time);
  const maxNeighbors = options.maxNeighbors ?? 1;
  const dropWater = options.dropWater ?? true;
  const passes = Math.max(1, options.passes ?? 2);
  const allowed = options.restrictTo ? new Set(options.restrictTo) : null;
  let released = 0;

  for (let pass = 0; pass < passes; pass++) {
    const ownership = regionOwnershipAt(world, options.time);
    const passOverrides = computeOverridesAt(world, options.time);
    const ownerOf = (cellId: string): string | undefined => {
      const cell = topology.byId.get(cellId);
      if (!cell) return undefined;
      const regionId = effectiveRegionId(cell, passOverrides);
      return regionId ? ownership.get(regionId) || undefined : undefined;
    };

    const victims: string[] = [];
    for (const cell of world.cells.features) {
      const id = cell.properties.id;
      if (allowed && !allowed.has(id)) continue;
      const owner = ownerOf(id);
      if (!owner) continue;

      const height = Number(overrides.get(id)?.height ?? cell.properties.height ?? 0);
      if (dropWater && height < sea) {
        victims.push(id);
        continue;
      }
      const neighbors = topology.neighbors.get(id) ?? [];
      if (neighbors.length === 0) continue;
      const same = neighbors.filter((neighborId) => ownerOf(neighborId) === owner).length;
      if (same <= maxNeighbors) victims.push(id);
    }

    if (victims.length === 0) break;
    if (options.epoch) paintStateInEpoch(world, victims, null, options.time);
    else paintState(world, victims, null, options.time);
    released += victims.length;
  }

  if (released > 0) mergeAutoRegions(world);
  return released;
}

/** Регионы, задетые кистью (для подсказок в UI). */
export function regionsOfCells(world: World, cellIds: string[]): string[] {
  const topology = topologyOf(world);
  const result = new Set<string>();
  for (const id of cellIds) {
    const regionId = topology.byId.get(id)?.properties.regionId;
    if (regionId) result.add(regionId);
  }
  return [...result];
}

export { toNumericDate };
