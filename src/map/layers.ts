import type { Feature, Geometry } from 'geojson';
import { effectiveRegionId, geoVariant, overridesAt } from '../state/geoOverrides';
import { dissolvedAreas, type DissolvedCollection } from '../state/topology';
import type { CellFeature, DictEntry, World } from '../state/types';
import type { LayerId, UiState } from '../state/ui';
import { regionOwnershipAt } from '../state/world';
import { activeSnapshot } from '../state/world';
import { dictEntryAt, hasSuccessions, nameAt, resolveDictId, resolveStateId, stateAt } from '../state/naming';
import {
  biomeColor,
  categoricalColor,
  heightColor,
  precipitationColor,
  temperatureColor,
  withAlpha,
} from './colors';

export type AnyFeature = Feature<Geometry, Record<string, unknown>>;

export interface PolygonLayer {
  id: LayerId;
  kind: 'cell' | 'region' | 'area' | 'line';
  features: AnyFeature[];
  fill: (feature: AnyFeature) => string | null;
  stroke?: string;
  strokeWidth?: number;
  dash?: string;
  opacity?: number;
  /** индивидуальные обводки — нужны рекам (толщина по расходу) и дорогам (стиль по типу) */
  strokeOf?: (feature: AnyFeature) => string | null;
  widthOf?: (feature: AnyFeature) => number;
  dashOf?: (feature: AnyFeature) => string | undefined;
}

/* ------------------------------------------------------------------ */
/* цвета справочников                                                  */
/* ------------------------------------------------------------------ */

function dictColor(entries: DictEntry[], id: string | undefined, offset: number): string | null {
  if (!id) return null;
  const entry = entries.find((item) => item.id === id);
  if (entry?.color) return entry.color;
  return categoricalColor(id, offset);
}

export function cultureColor(world: World, id: string | undefined): string | null {
  return dictColor(world.dictionaries.cultures, id, 0);
}
export function religionColor(world: World, id: string | undefined): string | null {
  return dictColor(world.dictionaries.religions, id, 5);
}
export function languageColor(world: World, id: string | undefined): string | null {
  return dictColor(world.dictionaries.languages, id, 9);
}
export function stateColor(world: World, id: string | undefined): string | null {
  if (!id) return null;
  return world.timeline.states.find((state) => state.id === id)?.color ?? categoricalColor(id, 2);
}

/**
 * Вариант кэша для слоёв, зависящих от времени. Если в мире есть переходы
 * (язык -> язык, империя -> республика), картинка меняется вместе со временем.
 */
export function namingVariant(world: World, ui: UiState): string {
  return hasSuccessions(world) ? `t${Math.round(ui.time)}` : 'all';
}

/** Ключ кэша слоя: зависит и от переходов имён, и от гео-правок эпохи. */
function layerVariant(world: World, ui: UiState): string {
  const geo = geoVariant(world, ui.time);
  return geo ? `${namingVariant(world, ui)}/${geo}` : namingVariant(world, ui);
}

export function heightExtent(world: World): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const feature of world.cells.features) {
    const height = feature.properties.height;
    if (typeof height !== 'number') continue;
    if (height < min) min = height;
    if (height > max) max = height;
  }
  if (!Number.isFinite(min)) return [0, 100];
  return [min, max];
}

export function seaLevelOf(world: World): number {
  if (typeof world.meta.seaLevel === 'number') return world.meta.seaLevel;
  const [min, max] = heightExtent(world);
  return min >= 0 && max <= 100 ? 20 : 0;
}

/* ------------------------------------------------------------------ */
/* слои                                                               */
/* ------------------------------------------------------------------ */

/** Стили линейных путей Azgaar. */
const ROUTE_STYLES: Record<string, { color: string; width: number; dash?: string }> = {
  roads: { color: '#f2dfb4', width: 1.3 },
  trails: { color: '#d8c39a', width: 0.9, dash: '3 2' },
  searoutes: { color: '#9fd0f2', width: 1.1, dash: '6 4' },
};

const ZONE_COLORS: Record<string, string> = {
  Invasion: '#e06c75',
  Rebels: '#d19a66',
  Proselytism: '#c678dd',
  Crusade: '#e5c07b',
  Disease: '#98c379',
  Disaster: '#56b6c2',
  Eruption: '#cf7a3f',
  Flood: '#61afef',
  Tsunami: '#3f7ecf',
  Landslide: '#a3685a',
  Avalanche: '#b0c4de',
  Drought: '#d8a657',
};

/** Толщина реки: логарифм расхода воды, чтобы ручьи не выглядели как Амазонка. */
function riverWidth(feature: AnyFeature): number {
  const discharge = Number(feature.properties.discharge ?? 0);
  const width = Number(feature.properties.width ?? 0);
  return Math.min(4.5, Math.max(0.8, 0.8 + Math.log2(1 + discharge) / 2.2 + width));
}

function zoneColor(properties: { type?: string; color?: string }): string {
  if (properties.color && properties.color.startsWith('#')) return properties.color;
  return ZONE_COLORS[properties.type ?? ''] ?? categoricalColor(properties.type ?? 'zone', 7);
}

const CELL_ATTRIBUTE: Record<'cultures' | 'religions' | 'languages', 'cultureId' | 'religionId' | 'languageId'> = {
  cultures: 'cultureId',
  religions: 'religionId',
  languages: 'languageId',
};

export interface BuildOptions {
  /** во время мазка кистью рисуем ячейки напрямую — растворение границ слишком дорого на кадр */
  fast?: boolean;
}

/**
 * Слои-полигоны снизу вверх. Тематика и политика рисуются не ячейками, а «растворёнными»
 * областями: соседние ячейки с одним значением сливаются, у области один контур.
 */
export function buildPolygonLayers(world: World, ui: UiState, options: BuildOptions = {}): PolygonLayer[] {
  const layers: PolygonLayer[] = [];
  const cells = world.cells.features as unknown as AnyFeature[];
  const [minHeight, maxHeight] = heightExtent(world);
  const sea = seaLevelOf(world);
  // в режиме правки вершин сглаживание выключаем: иначе контур не совпадает с ручками
  const smoothing = options.fast || ui.tool === 'vertices' ? 0 : ui.smoothing;
  const fast = Boolean(options.fast);
  // география эпохи: базовые атрибуты ячеек плюс накопленные правки
  const overrides = overridesAt(world, ui.time);
  const variant = layerVariant(world, ui);

  const asFeatures = (collection: DissolvedCollection): AnyFeature[] =>
    collection.features as unknown as AnyFeature[];

  // --- рельеф по ячейкам (если нет растровой сетки)
  if (ui.layers.heightmap && !world.layers.heightmap && cells.length > 0) {
    layers.push({
      id: 'heightmap',
      kind: 'cell',
      features: cells,
      fill: (feature) => {
        const patched = overrides.get(String(feature.properties.id))?.height;
        const height = patched ?? (feature.properties.height as number | undefined);
        return typeof height === 'number' ? heightColor(height, minHeight, maxHeight, sea) : null;
      },
    });
  }

  // --- климатические слои: результат симуляции
  if (ui.layers.temperature && cells.length > 0) {
    layers.push({
      id: 'temperature',
      kind: 'cell',
      features: cells,
      fill: (feature) => {
        const value = feature.properties.temperature as number | undefined;
        return typeof value === 'number' ? temperatureColor(value) : null;
      },
    });
  }
  if (ui.layers.precipitation && cells.length > 0) {
    layers.push({
      id: 'precipitation',
      kind: 'cell',
      features: cells,
      fill: (feature) => {
        const value = feature.properties.precipitation as number | undefined;
        return typeof value === 'number' ? precipitationColor(value) : null;
      },
    });
  }

  // --- биомы
  if (ui.layers.biomes && cells.length > 0) {
    const biomeOf = (id: string, base: unknown): string | undefined =>
      (overrides.get(id)?.biome ?? (base as string | undefined)) || undefined;

    if (fast) {
      layers.push({
        id: 'biomes',
        kind: 'cell',
        features: cells,
        fill: (feature) => biomeColor(biomeOf(String(feature.properties.id), feature.properties.biome)),
      });
    } else {
      layers.push({
        id: 'biomes',
        kind: 'area',
        features: asFeatures(
          dissolvedAreas(world, 'biomes', variant, smoothing, (feature) =>
            biomeOf(feature.properties.id, feature.properties.biome),
          ),
        ),
        fill: (feature) => biomeColor(feature.properties.id as string),
        stroke: 'rgba(10,14,20,0.35)',
        strokeWidth: 0.7,
      });
    }
  }

  // --- культуры / религии / языки
  for (const layerId of ['cultures', 'religions', 'languages'] as const) {
    if (!ui.layers[layerId]) continue;
    const attribute = CELL_ATTRIBUTE[layerId];
    const colorOf =
      layerId === 'cultures'
        ? (id: string | undefined) => cultureColor(world, id)
        : layerId === 'religions'
          ? (id: string | undefined) => religionColor(world, id)
          : (id: string | undefined) => languageColor(world, id);

    const custom = world.layers[layerId];
    if (custom && custom.features.length > 0) {
      // мир принёс готовые ареалы — рисуем их как есть
      layers.push({
        id: layerId,
        kind: 'area',
        features: custom.features as unknown as AnyFeature[],
        fill: (feature) =>
          (feature.properties.color as string | undefined) ?? colorOf(feature.properties.id as string),
        stroke: 'rgba(10,14,20,0.5)',
        strokeWidth: 0.9,
        opacity: 0.78,
      });
      continue;
    }
    if (cells.length === 0) continue;

    const attributeOf = (id: string, base: unknown): string | undefined =>
      ((overrides.get(id)?.[attribute] as string | undefined) ?? (base as string | undefined)) || undefined;

    if (fast) {
      layers.push({
        id: layerId,
        kind: 'cell',
        features: cells,
        fill: (feature) =>
          colorOf(attributeOf(String(feature.properties.id), feature.properties[attribute])),
        opacity: 0.78,
      });
    } else {
      const dictKind = layerId;
      layers.push({
        id: layerId,
        kind: 'area',
        features: asFeatures(
          dissolvedAreas(world, layerId, variant, smoothing, (feature) =>
            resolveDictId(world, dictKind, attributeOf(feature.properties.id, feature.properties[attribute]), ui.time),
          ),
        ),
        fill: (feature) => colorOf(feature.properties.id as string),
        stroke: 'rgba(10,14,20,0.5)',
        strokeWidth: 0.9,
        opacity: 0.78,
      });
    }
  }

  // --- политическая карта на текущий момент времени
  if (ui.layers.states) {
    const ownership = regionOwnershipAt(world, ui.time);
    const variant = activeSnapshot(world, ui.time)?.id ?? 'base';
    const derived = world.meta.regionSource !== 'geometry';

    if (derived && cells.length > 0) {
      const ownerOfCell = (feature: CellFeature): string | undefined => {
        const regionId = effectiveRegionId(feature, overrides);
        if (!regionId) return undefined;
        return resolveStateId(world, ownership.get(regionId), ui.time);
      };
      if (fast) {
        layers.push({
          id: 'states',
          kind: 'cell',
          features: cells,
          fill: (feature) => {
            const owner = ownerOfCell(feature as unknown as CellFeature);
            return owner ? stateColor(world, owner) : null;
          },
          opacity: 0.85,
        });
      } else {
        layers.push({
          id: 'states',
          kind: 'area',
          features: asFeatures(dissolvedAreas(world, 'states', variant, smoothing, ownerOfCell)),
          fill: (feature) => stateColor(world, feature.properties.id as string),
          stroke: 'rgba(8,11,16,0.85)',
          strokeWidth: 1.4,
          opacity: 0.85,
        });
      }
    } else if (world.regions.features.length > 0) {
      // регионы со своей геометрией: растворяем их сами по владельцу
      layers.push({
        id: 'states',
        kind: 'area',
        features: asFeatures(
          dissolvedAreas(
            world,
            'states-geom',
            variant,
            smoothing,
            ((feature: Feature<Geometry, { id: string }>) =>
              resolveStateId(world, ownership.get(feature.properties.id), ui.time)) as never,
            world.regions.features as never,
          ),
        ),
        fill: (feature) => stateColor(world, feature.properties.id as string),
        stroke: 'rgba(8,11,16,0.85)',
        strokeWidth: 1.4,
        opacity: 0.85,
      });
    }
  }

  // --- границы регионов (полезно при рисовании политики)
  if (ui.layers.regionBorders) {
    const derived = world.meta.regionSource !== 'geometry';
    const features = derived
      ? asFeatures(
          dissolvedAreas(world, 'regionBorders', variant, smoothing, (feature) =>
            effectiveRegionId(feature, overrides),
          ),
        )
      : (world.regions.features as unknown as AnyFeature[]);
    layers.push({
      id: 'regionBorders',
      kind: 'region',
      features,
      fill: () => null,
      stroke: 'rgba(255,255,255,0.32)',
      strokeWidth: 0.8,
      dash: '3 2',
    });
  }

  // --- зоны (нашествия, кризисы и прочие оверлеи)
  if (ui.layers.zones && world.layers.zones && world.layers.zones.features.length > 0) {
    layers.push({
      id: 'zones',
      kind: 'area',
      features: world.layers.zones.features as unknown as AnyFeature[],
      fill: (feature) => withAlpha(zoneColor(feature.properties as { type?: string; color?: string }), 0.5),
      strokeOf: (feature) => zoneColor(feature.properties as { type?: string; color?: string }),
      strokeWidth: 1.6,
      dash: '5 3',
    });
  }

  // --- реки: толщина по расходу воды
  if (ui.layers.rivers && world.layers.rivers && world.layers.rivers.features.length > 0) {
    layers.push({
      id: 'rivers',
      kind: 'line',
      features: world.layers.rivers.features as unknown as AnyFeature[],
      fill: () => null,
      stroke: '#5aa7e6',
      widthOf: (feature) => riverWidth(feature),
    });
  }

  // --- дороги, тропы, морские пути. Сначала тёмная «подложка», чтобы линии
  //     читались и на светлых биомах, и на насыщенной политике
  if (ui.layers.routes && world.layers.routes && world.layers.routes.features.length > 0) {
    layers.push({
      id: 'routes',
      kind: 'line',
      features: world.layers.routes.features as unknown as AnyFeature[],
      fill: () => null,
      stroke: 'rgba(10,14,20,0.5)',
      widthOf: (feature) => (ROUTE_STYLES[String(feature.properties.group ?? 'roads')]?.width ?? 1) + 1.4,
    });
    layers.push({
      id: 'routes',
      kind: 'line',
      features: world.layers.routes.features as unknown as AnyFeature[],
      fill: () => null,
      strokeOf: (feature) => ROUTE_STYLES[String(feature.properties.group ?? 'roads')]?.color ?? '#d8c9a3',
      widthOf: (feature) => ROUTE_STYLES[String(feature.properties.group ?? 'roads')]?.width ?? 1,
      dashOf: (feature) => ROUTE_STYLES[String(feature.properties.group ?? 'roads')]?.dash,
      opacity: 0.9,
    });
  }

  // --- сетка ячеек
  if (ui.layers.mesh && cells.length > 0) {
    layers.push({
      id: 'mesh',
      kind: 'cell',
      features: cells,
      fill: () => null,
      stroke: 'rgba(255,255,255,0.13)',
      strokeWidth: 0.4,
    });
  }

  return layers;
}

/* ------------------------------------------------------------------ */
/* легенда                                                            */
/* ------------------------------------------------------------------ */

export interface LegendEntry {
  id: string;
  label: string;
  color: string;
  count?: number;
}

export function legendFor(layerId: LayerId, world: World, ui: UiState): LegendEntry[] {
  const overrides = overridesAt(world, ui.time);
  const countBy = (key: 'biome' | 'cultureId' | 'religionId' | 'languageId'): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const feature of world.cells.features) {
      const value = overrides.get(feature.properties.id)?.[key] ?? feature.properties[key];
      if (value === undefined || value === null || value === '') continue;
      const id = String(value);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  };

  const fromDict = (entries: DictEntry[], counts: Map<string, number>, offset: number): LegendEntry[] => {
    const known = entries.map((entry) => ({
      id: entry.id,
      label: nameAt(entry, ui.time),
      color: entry.color ?? categoricalColor(entry.id, offset),
      count: counts.get(entry.id) ?? 0,
    }));
    for (const [id, count] of counts) {
      if (!known.some((entry) => entry.id === id)) {
        known.push({ id, label: id, color: categoricalColor(id, offset), count });
      }
    }
    return known.filter((entry) => (entry.count ?? 0) > 0).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  };

  switch (layerId) {
    case 'biomes': {
      const counts = countBy('biome');
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ id: name, label: name, color: biomeColor(name), count }));
    }
    case 'cultures':
      return fromDict(world.dictionaries.cultures, countBy('cultureId'), 0);
    case 'religions':
      return fromDict(world.dictionaries.religions, countBy('religionId'), 5);
    case 'languages':
      return fromDict(world.dictionaries.languages, countBy('languageId'), 9);
    case 'zones':
      return (world.layers.zones?.features ?? []).map((feature) => ({
        id: feature.properties.id,
        label: feature.properties.name ?? feature.properties.type ?? feature.properties.id,
        color: zoneColor(feature.properties),
      }));
    case 'routes': {
      const groups = new Map<string, number>();
      for (const feature of world.layers.routes?.features ?? []) {
        const group = String(feature.properties.group ?? 'roads');
        groups.set(group, (groups.get(group) ?? 0) + 1);
      }
      return [...groups.entries()].map(([group, count]) => ({
        id: group,
        label: group === 'roads' ? 'дороги' : group === 'trails' ? 'тропы' : group === 'searoutes' ? 'морские пути' : group,
        color: ROUTE_STYLES[group]?.color ?? '#d9c69f',
        count,
      }));
    }
    case 'states': {
      const ownership = regionOwnershipAt(world, ui.time);
      const counts = new Map<string, number>();
      for (const owner of ownership.values()) {
        if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
      return world.timeline.states
        .map((state) => ({
          id: state.id,
          label: nameAt(state, ui.time),
          color: state.color,
          count: counts.get(state.id) ?? 0,
        }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
    }
    default:
      return [];
  }
}
