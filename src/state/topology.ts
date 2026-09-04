/**
 * Кэши поверх геометрии мира: центроиды ячеек, пространственный индекс для кисти,
 * соседство ячеек и растворённые границы тематических слоёв.
 *
 * Геометрия ячеек меняется редко (импорт, undo), а атрибуты — на каждый мазок кистью,
 * поэтому кэши разделены: топология живёт на массиве фич, растворение — на ревизии мира.
 */
import { quadtree, type Quadtree } from 'd3-quadtree';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { buildAdjacency, dissolveByKey } from '../util/dissolve';
import { effectiveRegionId, geoVariant, overridesAt } from './geoOverrides';
import type { CellFeature, CellProperties, ThematicProperties, World } from './types';
import { layerRevision } from './world';

export interface CellPoint {
  id: string;
  lon: number;
  lat: number;
}

export interface Topology {
  cells: CellFeature[];
  byId: Map<string, CellFeature>;
  points: CellPoint[];
  pointById: Map<string, CellPoint>;
  /** [minLon, minLat, maxLon, maxLat] для отсечения невидимых ячеек при отрисовке */
  bbox: Map<string, [number, number, number, number]>;
  tree: Quadtree<CellPoint>;
  neighbors: Map<string, string[]>;
}

function centroidOf(geometry: Geometry | null | undefined): [number, number] | null {
  if (!geometry || !('coordinates' in geometry)) return null;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      sumX += coords[0] as number;
      sumY += coords[1] as number;
      count += 1;
      return;
    }
    for (const item of coords) walk(item);
  };
  walk((geometry as { coordinates: unknown }).coordinates);
  return count > 0 ? [sumX / count, sumY / count] : null;
}

function bboxOf(geometry: Geometry | null | undefined): [number, number, number, number] | null {
  if (!geometry || !('coordinates' in geometry)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const x = coords[0] as number;
      const y = coords[1] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const item of coords) walk(item);
  };
  walk((geometry as { coordinates: unknown }).coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

const topologyCache = new WeakMap<object, Topology>();

export function topologyOf(world: World): Topology {
  const features = world.cells.features;
  const cached = topologyCache.get(features);
  if (cached) return cached;

  const byId = new Map<string, CellFeature>();
  const points: CellPoint[] = [];
  const pointById = new Map<string, CellPoint>();
  const bbox = new Map<string, [number, number, number, number]>();
  for (const feature of features) {
    const id = feature.properties.id;
    byId.set(id, feature);
    const centroid = centroidOf(feature.geometry);
    if (centroid) {
      const point = { id, lon: centroid[0], lat: centroid[1] };
      points.push(point);
      pointById.set(id, point);
    }
    const box = bboxOf(feature.geometry);
    if (box) bbox.set(id, box);
  }

  const topology: Topology = {
    cells: features,
    byId,
    points,
    pointById,
    bbox,
    tree: quadtree<CellPoint>()
      .x((point) => point.lon)
      .y((point) => point.lat)
      .addAll(points),
    neighbors: buildAdjacency(features as Array<Feature<Geometry, CellProperties>>),
  };
  topologyCache.set(features, topology);
  return topology;
}

/* ------------------------------------------------------------------ */
/* растворённые границы                                                */
/* ------------------------------------------------------------------ */

export type DissolvedCollection = FeatureCollection<Geometry, ThematicProperties>;

/** Какая ревизия данных влияет на слой. */
function revisionKeyFor(layerId: string): string {
  if (layerId.startsWith('states')) return 'states';
  if (layerId === 'regionBorders') return 'regions';
  return layerId;
}

interface CacheEntry {
  revision: number;
  value: DissolvedCollection;
}

const dissolveCache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 24;

/**
 * Растворить ячейки по ключу и закэшировать результат до следующей правки мира.
 * `variant` различает варианты одного слоя (например, эпоху для политической карты).
 */
export function dissolvedAreas(
  world: World,
  layerId: string,
  variant: string,
  smoothing: number,
  keyOf: (feature: CellFeature) => string | null | undefined,
  source?: Array<Feature<Geometry, ThematicProperties>>,
): DissolvedCollection {
  const cacheKey = `${layerId}|${variant}|${smoothing}`;
  const revision = layerRevision(revisionKeyFor(layerId));
  const cached = dissolveCache.get(cacheKey);
  if (cached && cached.revision === revision) return cached.value;

  const input = (source ?? world.cells.features) as unknown as CellFeature[];
  const groups = dissolveByKey(input, keyOf as never, { smoothing });

  const features: Array<Feature<Geometry, ThematicProperties>> = [];
  for (const [key, coordinates] of groups) {
    if (coordinates.length === 0) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: coordinates as Position[][][] },
      properties: { id: key },
    });
  }

  const value: DissolvedCollection = { type: 'FeatureCollection', features };
  if (dissolveCache.size >= CACHE_LIMIT) {
    const oldest = dissolveCache.keys().next().value;
    if (oldest) dissolveCache.delete(oldest);
  }
  dissolveCache.set(cacheKey, { revision, value });
  return value;
}

/**
 * Геометрия регионов, выведенная из ячеек (regionSource === 'cells').
 * Зависит от времени: принадлежность ячеек региону меняется по эпохам.
 */
export function regionGeometries(world: World, smoothing = 0, time = 0): Map<string, Position[][][]> {
  const cacheKey = `__regions|${smoothing}|${geoVariant(world, time)}`;
  const revision = layerRevision('regions') + layerRevision('geo');
  const cached = regionGeometryCache.get(cacheKey);
  if (cached && cached.revision === revision) return cached.value;
  const overrides = overridesAt(world, time);
  const value = dissolveByKey(
    world.cells.features as Array<Feature<Geometry, CellProperties>>,
    (feature) => effectiveRegionId(feature as CellFeature, overrides),
    { smoothing },
  );
  if (regionGeometryCache.size > 8) regionGeometryCache.clear();
  regionGeometryCache.set(cacheKey, { revision, value });
  return value;
}

const regionGeometryCache = new Map<string, { revision: number; value: Map<string, Position[][][]> }>();

/**
 * Базовая геометрия регионов — без правок эпох. Идёт в архив как удобное
 * представление; источник правды для истории — `snapshot.geo`.
 */
export function baseRegionGeometries(world: World, smoothing = 0): Map<string, Position[][][]> {
  return dissolveByKey(
    world.cells.features as Array<Feature<Geometry, CellProperties>>,
    (feature) => feature.properties.regionId,
    { smoothing },
  );
}
