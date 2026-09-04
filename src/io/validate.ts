import {
  SCHEMA_VERSION,
  emptyFeatureCollection,
  emptyWorld,
  type CellOverride,
  type CellProperties,
  type DictEntry,
  type CurrentProperties,
  type RegionProperties,
  type RiverProperties,
  type RouteProperties,
  type ThematicProperties,
  type ZoneProperties,
  type Snapshot,
  type StateDef,
  type TimelineEvent,
  type World,
} from '../state/types';
import { uid } from '../util/id';
import { rewindFeatures } from '../util/geo';

export class ValidationError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asFeatureCollection<T>(value: unknown, kind: string) {
  const empty = emptyFeatureCollection<T>();
  if (!isObject(value)) return empty;
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new ValidationError(`${kind}: ожидался GeoJSON FeatureCollection`);
  }
  const features = (value.features as unknown[]).filter(
    (f) => isObject(f) && isObject((f as Record<string, unknown>).geometry),
  ) as never[];
  return { type: 'FeatureCollection', features } as typeof empty;
}

/**
 * Приводит произвольный разобранный объект к валидному World:
 * добивает недостающие поля, генерирует id, чинит типы.
 * Здесь же живут миграции между версиями схемы.
 */
/** Гео-правки эпохи: оставляем только известные поля и валидные типы. */
function normalizeGeo(raw: Record<string, unknown>): Record<string, CellOverride> {
  const result: Record<string, CellOverride> = {};
  for (const [cellId, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const patch: CellOverride = {};
    if (typeof value.height === 'number' && Number.isFinite(value.height)) patch.height = value.height;
    for (const key of ['biome', 'cultureId', 'religionId', 'languageId'] as const) {
      if (typeof value[key] === 'string' && value[key]) patch[key] = value[key] as string;
    }
    // пустая строка у regionId осмысленна: «с этой эпохи ячейка вне регионов»
    if (typeof value.regionId === 'string') patch.regionId = value.regionId;
    if (Object.keys(patch).length > 0) result[cellId] = patch;
  }
  return result;
}

export function normalizeWorld(raw: unknown): World {
  if (!isObject(raw)) throw new ValidationError('Ожидался объект мира');

  const base = emptyWorld();
  const meta = isObject(raw.meta) ? raw.meta : {};
  const layers = isObject(raw.layers) ? raw.layers : {};
  const points = isObject(raw.points) ? raw.points : {};
  const timeline = isObject(raw.timeline) ? raw.timeline : {};
  const dictionaries = isObject(raw.dictionaries) ? raw.dictionaries : {};

  const world: World = {
    meta: {
      ...base.meta,
      ...(meta as object),
      name: typeof meta.name === 'string' && meta.name ? meta.name : base.meta.name,
      schemaVersion: typeof meta.schemaVersion === 'number' ? meta.schemaVersion : SCHEMA_VERSION,
    },
    cells: asFeatureCollection<CellProperties>(raw.cells ?? raw.map, 'map.geojson'),
    regions: asFeatureCollection<RegionProperties>(raw.regions, 'regions.geojson'),
    layers: {
      heightmap: isObject(layers.heightmap) ? (layers.heightmap as unknown as World['layers']['heightmap']) : undefined,
      winds: isObject(layers.winds) ? (layers.winds as unknown as World['layers']['winds']) : undefined,
      cultures: layers.cultures ? asFeatureCollection<ThematicProperties>(layers.cultures, 'cultures.geojson') : undefined,
      religions: layers.religions ? asFeatureCollection<ThematicProperties>(layers.religions, 'religions.geojson') : undefined,
      languages: layers.languages ? asFeatureCollection<ThematicProperties>(layers.languages, 'languages.geojson') : undefined,
      rivers: layers.rivers ? asFeatureCollection<RiverProperties>(layers.rivers, 'rivers.geojson') : undefined,
      routes: layers.routes ? asFeatureCollection<RouteProperties>(layers.routes, 'routes.geojson') : undefined,
      zones: layers.zones ? asFeatureCollection<ZoneProperties>(layers.zones, 'zones.geojson') : undefined,
      currents: layers.currents
        ? asFeatureCollection<CurrentProperties>(layers.currents, 'currents.geojson')
        : undefined,
    },
    points: {
      burgs: asArray<World['points']['burgs'][number]>(points.burgs),
      markers: asArray<World['points']['markers'][number]>(points.markers),
    },
    timeline: {
      snapshots: asArray<Snapshot>(timeline.snapshots),
      events: asArray<TimelineEvent>(timeline.events),
      states: asArray<StateDef>(timeline.states),
    },
    dictionaries: {
      cultures: asArray<DictEntry>(dictionaries.cultures),
      religions: asArray<DictEntry>(dictionaries.religions),
      languages: asArray<DictEntry>(dictionaries.languages),
      biomes: asArray<DictEntry>(dictionaries.biomes),
    },
  };

  // --- id для фич: без них ничего не выбирается и не красится
  const cellIds = new Set<string>();
  world.cells.features.forEach((feature, index) => {
    feature.properties = (feature.properties ?? {}) as CellProperties;
    let id = String(feature.properties.id ?? `cell-${index}`);
    while (cellIds.has(id)) id = `${id}_`;
    cellIds.add(id);
    feature.properties.id = id;
  });

  const regionIds = new Set<string>();
  world.regions.features.forEach((feature, index) => {
    feature.properties = (feature.properties ?? {}) as RegionProperties;
    let id = String(feature.properties.id ?? `region-${index}`);
    while (regionIds.has(id)) id = `${id}_`;
    regionIds.add(id);
    feature.properties.id = id;
  });

  world.points.burgs = world.points.burgs
    .filter((burg) => Number.isFinite(Number(burg?.x)) && Number.isFinite(Number(burg?.y)))
    .map((burg, index) => ({
      ...burg,
      id: String(burg.id ?? `burg-${index}`),
      name: String(burg.name ?? `Burg ${index + 1}`),
      x: Number(burg.x),
      y: Number(burg.y),
      from: typeof burg.from === 'string' && burg.from ? burg.from : undefined,
      to: typeof burg.to === 'string' && burg.to ? burg.to : undefined,
      names: Array.isArray(burg.names) ? burg.names : undefined,
    }));

  world.points.markers = world.points.markers
    .filter((marker) => Number.isFinite(Number(marker?.x)) && Number.isFinite(Number(marker?.y)))
    .map((marker, index) => ({
      ...marker,
      id: String(marker.id ?? `marker-${index}`),
      name: String(marker.name ?? `Marker ${index + 1}`),
      x: Number(marker.x),
      y: Number(marker.y),
      from: typeof marker.from === 'string' && marker.from ? marker.from : undefined,
      to: typeof marker.to === 'string' && marker.to ? marker.to : undefined,
      names: Array.isArray(marker.names) ? marker.names : undefined,
    }));

  world.timeline.states = world.timeline.states.map((state, index) => ({
    id: String(state?.id ?? `state-${index}`),
    name: String(state?.name ?? `State ${index + 1}`),
    color: typeof state?.color === 'string' ? state.color : '#888888',
    note: state?.note,
  }));

  world.timeline.snapshots = world.timeline.snapshots.map((snapshot, index) => ({
    id: String(snapshot?.id ?? uid('snap')),
    date: String(snapshot?.date ?? index),
    label: snapshot?.label,
    notes: snapshot?.notes,
    geo: isObject(snapshot?.geo) ? normalizeGeo(snapshot.geo as Record<string, unknown>) : undefined,
    regionState: isObject(snapshot?.regionState)
      ? (Object.fromEntries(
          Object.entries(snapshot.regionState as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
        ) as Record<string, string>)
      : {},
  }));

  world.timeline.events = world.timeline.events.map((event, index) => ({
    id: String(event?.id ?? uid('ev')),
    date: String(event?.date ?? 0),
    title: String(event?.title ?? `Событие ${index + 1}`),
    description: event?.description,
    regionId: event?.regionId,
  }));

  // Регионы не заданы. Если у ячеек есть политика — иначе её не сохранить —
  // делаем «ячейка = регион». Пустая карта остаётся без регионов: их создаст кисть.
  const cellsCarryRegionId = world.cells.features.some((feature) => feature.properties.regionId);
  const cellsCarryStateId = world.cells.features.some((feature) => feature.properties.stateId);
  if (
    world.regions.features.length === 0 &&
    world.cells.features.length > 0 &&
    !cellsCarryRegionId &&
    cellsCarryStateId
  ) {
    for (const feature of world.cells.features) {
      feature.properties.regionId = feature.properties.id;
      world.regions.features.push({
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: [] },
        properties: {
          id: feature.properties.id,
          name: feature.properties.name,
          stateId: feature.properties.stateId,
        },
      });
    }
  }

  // --- id у линейных слоёв и зон
  for (const [collection, prefix] of [
    [world.layers.rivers, 'river'],
    [world.layers.routes, 'route'],
    [world.layers.zones, 'zone'],
    [world.layers.currents, 'current'],
  ] as const) {
    collection?.features.forEach((feature, index) => {
      feature.properties = (feature.properties ?? {}) as never;
      const properties = feature.properties as { id?: string };
      if (!properties.id) properties.id = `${prefix}-${index}`;
    });
  }

  // --- сверка ячеек и регионов: ссылка на несуществующий регион ломает политический слой
  const regionIdSet = new Set(world.regions.features.map((feature) => feature.properties.id));
  const syntheticByState = new Map<string, string>();
  for (const feature of world.cells.features) {
    const regionId = feature.properties.regionId;
    if (!regionId || regionIdSet.has(regionId)) continue;
    const stateId = feature.properties.stateId;
    if (!stateId) {
      delete feature.properties.regionId;
      continue;
    }
    let synthetic = syntheticByState.get(stateId);
    if (!synthetic) {
      synthetic = `region-${stateId}-core`;
      syntheticByState.set(stateId, synthetic);
      if (!regionIdSet.has(synthetic)) {
        regionIdSet.add(synthetic);
        world.regions.features.push({
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: [] },
          properties: { id: synthetic, name: `${stateId}: земли`, stateId },
        });
      }
    }
    feature.properties.regionId = synthetic;
  }

  // --- настройки климата: экватор по умолчанию на нуле
  const climate = isObject((meta as Record<string, unknown>).climate)
    ? ((meta as Record<string, unknown>).climate as Record<string, unknown>)
    : {};
  world.meta.climate = {
    equatorLat: typeof climate.equatorLat === 'number' ? climate.equatorLat : 0,
    temperatureEquator: typeof climate.temperatureEquator === 'number' ? climate.temperatureEquator : 27,
    temperaturePole: typeof climate.temperaturePole === 'number' ? climate.temperaturePole : -24,
  };

  // --- уровень моря и источник геометрии регионов (миграция v1 -> v2)
  if (world.meta.seaLevel === undefined) {
    let min = Infinity;
    let max = -Infinity;
    for (const feature of world.cells.features) {
      const height = feature.properties.height;
      if (typeof height !== 'number') continue;
      if (height < min) min = height;
      if (height > max) max = height;
    }
    world.meta.seaLevel = Number.isFinite(min) && min >= 0 && max <= 100 ? 20 : 0;
  }
  if (!world.meta.regionSource) {
    const hasRegionGeometry = world.regions.features.some((feature) => {
      const geometry = feature.geometry as { coordinates?: unknown[] } | null;
      return Array.isArray(geometry?.coordinates) && geometry!.coordinates!.length > 0;
    });
    const cellsCarryRegions = world.cells.features.some((feature) => feature.properties.regionId);
    world.meta.regionSource = hasRegionGeometry && !cellsCarryRegions ? 'geometry' : 'cells';
  }

  // d3-geo требует «обратной» намотки колец — иначе полигоны выворачиваются наизнанку
  rewindFeatures(world.cells);
  rewindFeatures(world.regions);
  rewindFeatures(world.layers.cultures);
  rewindFeatures(world.layers.religions);
  rewindFeatures(world.layers.languages);
  rewindFeatures(world.layers.zones);

  world.meta.schemaVersion = SCHEMA_VERSION;
  return world;
}
