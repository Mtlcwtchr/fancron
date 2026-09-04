/**
 * Адаптер Azgaar's Fantasy Map Generator -> внутренняя модель мира.
 *
 * Поддерживаются:
 *  - GIS data export (GeoJSON): *_cells.geojson, *_states.geojson, *_provinces.geojson,
 *    *_burgs.geojson, *_markers.geojson  (координаты уже в lon/lat)
 *  - CSV export: burgs, states, provinces, cultures, religions, markers
 *
 * Сырые файлы никогда не хранятся: всё конвертируется в схему из раздела 4 ТЗ.
 * https://github.com/Azgaar/Fantasy-Map-Generator/wiki/GIS-data-export
 */
import type { Feature, FeatureCollection, Geometry, Point, Position } from 'geojson';
import { parseCsv, pick, pickBool, pickNumber, type CsvTable } from './csv';
import { normalizeWorld } from './validate';
import { AZGAAR_BIOMES, CATEGORICAL } from '../map/colors';
import { slugify } from '../util/id';
import {
  emptyWorld,
  type Burg,
  type CellProperties,
  type DictEntry,
  type MarkerPoint,
  type RegionProperties,
  type StateDef,
  type World,
} from '../state/types';

type FileKind =
  | 'cells'
  | 'states'
  | 'provinces'
  | 'burgs'
  | 'markers'
  | 'cultures'
  | 'religions'
  | 'rivers'
  | 'routes'
  | 'world'
  | 'unknown';

interface LoadedFile {
  name: string;
  kind: FileKind;
  json?: Record<string, unknown>;
  csv?: CsvTable;
}

export interface AzgaarImportResult {
  world: World;
  log: string[];
}

/* ------------------------------------------------------------------ */
/* распознавание файлов                                                */
/* ------------------------------------------------------------------ */

function propKeys(json: Record<string, unknown>): string[] {
  const features = (json.features as unknown[]) ?? [];
  const first = features[0] as Feature | undefined;
  return first?.properties ? Object.keys(first.properties).map((k) => k.toLowerCase()) : [];
}

function geometryType(json: Record<string, unknown>): string | undefined {
  const features = (json.features as unknown[]) ?? [];
  const first = features[0] as Feature | undefined;
  return first?.geometry?.type;
}

function classifyJson(name: string, json: Record<string, unknown>): FileKind {
  const lower = name.toLowerCase();
  if (json.type !== 'FeatureCollection') {
    // цельный дамп внутренней модели
    if (json.meta || json.cells || json.timeline) return 'world';
    return 'unknown';
  }
  const keys = propKeys(json);
  const geom = geometryType(json);

  if (lower.includes('cell') || keys.includes('biome')) return 'cells';
  if (lower.includes('province') || (keys.includes('province') && geom !== 'Point')) return 'provinces';
  if (lower.includes('marker') || keys.includes('icon')) return 'markers';
  if (lower.includes('burg') || (geom === 'Point' && (keys.includes('population') || keys.includes('capital'))))
    return 'burgs';
  if (lower.includes('river')) return 'rivers';
  if (lower.includes('route') || lower.includes('road')) return 'routes';
  if (lower.includes('state') || keys.includes('state')) return 'states';
  if (geom === 'Point') return 'markers';
  return 'unknown';
}

function classifyCsv(name: string, csv: CsvTable): FileKind {
  const lower = name.toLowerCase();
  const headers = csv.headers.map((h) => h.toLowerCase());
  const has = (...names: string[]) => names.some((n) => headers.includes(n));

  if (lower.includes('burg') || has('burg')) return 'burgs';
  if (lower.includes('marker') || has('marker')) return 'markers';
  if (lower.includes('culture') || has('namesbase')) return 'cultures';
  if (lower.includes('religion') || (has('religion') && has('deity', 'believers'))) return 'religions';
  if (lower.includes('province') || has('province')) return 'provinces';
  if (lower.includes('state') || has('state')) return 'states';
  return 'unknown';
}

async function loadFile(file: File): Promise<LoadedFile> {
  const text = await file.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(text) as Record<string, unknown>;
    return { name: file.name, kind: classifyJson(file.name, json), json };
  }
  const csv = parseCsv(text);
  return { name: file.name, kind: classifyCsv(file.name, csv), csv };
}

/* ------------------------------------------------------------------ */
/* вспомогательное                                                     */
/* ------------------------------------------------------------------ */

function refId(prefix: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim();
  if (value === '') return undefined;
  if (/^-?\d+$/.test(value)) return `${prefix}-${value}`;
  return `${prefix}-${slugify(value, 'x')}`;
}

function numberFrom(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : undefined;
}

function prop(properties: Record<string, unknown> | null | undefined, ...names: string[]): unknown {
  if (!properties) return undefined;
  const normalized = new Map<string, unknown>();
  for (const key of Object.keys(properties)) normalized.set(key.toLowerCase().replace(/[\s_]+/g, ''), properties[key]);
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[\s_]+/g, ''));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function biomeName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') return AZGAAR_BIOMES[raw] ?? `Biome ${raw}`;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && String(raw).trim() !== '') return AZGAAR_BIOMES[asNumber] ?? `Biome ${raw}`;
  return String(raw);
}

function centroidOf(geometry: Geometry): [number, number] | null {
  const positions: Position[] = [];
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      positions.push(coords as Position);
      return;
    }
    for (const item of coords) walk(item);
  };
  if ('coordinates' in geometry) walk((geometry as { coordinates: unknown }).coordinates);
  if (positions.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const position of positions) {
    x += position[0];
    y += position[1];
  }
  return [x / positions.length, y / positions.length];
}

/* ------------------------------------------------------------------ */
/* главный импортёр                                                    */
/* ------------------------------------------------------------------ */

export async function importAzgaarFiles(files: File[]): Promise<AzgaarImportResult> {
  const log: string[] = [];
  const loaded: LoadedFile[] = [];

  for (const file of files) {
    try {
      const item = await loadFile(file);
      loaded.push(item);
      log.push(`${file.name}: распознан как «${item.kind}»`);
    } catch (error) {
      log.push(`${file.name}: не прочитан — ${(error as Error).message}`);
    }
  }

  const world = emptyWorld(guessWorldName(files));
  world.meta.source = 'azgaar';
  world.meta.seaLevel = 20;

  const byKind = (kind: FileKind) => loaded.filter((item) => item.kind === kind);

  const statesByRef = new Map<string, StateDef>();
  const culturesByRef = new Map<string, DictEntry>();
  const religionsByRef = new Map<string, DictEntry>();
  const languagesByRef = new Map<string, DictEntry>();
  const cultureLanguage = new Map<string, string>();

  /* --- справочники из CSV --- */
  for (const item of byKind('cultures')) {
    if (!item.csv) continue;
    for (const row of item.csv.rows) {
      const id = refId('culture', pick(row, 'id') ?? pick(row, 'culture'));
      if (!id) continue;
      const name = pick(row, 'culture', 'name') ?? id;
      culturesByRef.set(id, { id, name, color: pick(row, 'color') });
      const base = pick(row, 'namesbase', 'names base', 'base');
      if (base) {
        const languageId = `language-${slugify(base, 'lang')}`;
        languagesByRef.set(languageId, { id: languageId, name: base });
        cultureLanguage.set(id, languageId);
      }
    }
    log.push(`${item.name}: культур — ${item.csv.rows.length}`);
  }

  for (const item of byKind('religions')) {
    if (!item.csv) continue;
    for (const row of item.csv.rows) {
      const id = refId('religion', pick(row, 'id') ?? pick(row, 'religion'));
      if (!id) continue;
      religionsByRef.set(id, {
        id,
        name: pick(row, 'religion', 'name') ?? id,
        color: pick(row, 'color'),
        note: pick(row, 'form', 'type'),
      });
    }
    log.push(`${item.name}: религий — ${item.csv.rows.length}`);
  }

  /* --- государства: CSV и/или GeoJSON --- */
  const registerState = (rawId: unknown, name?: string, color?: string): string | undefined => {
    const id = refId('state', rawId);
    if (!id) return undefined;
    const existing = statesByRef.get(id);
    if (existing) {
      if (name && (!existing.name || existing.name === existing.id)) existing.name = name;
      if (color) existing.color = color;
      return id;
    }
    statesByRef.set(id, {
      id,
      name: name ?? id,
      color: color ?? CATEGORICAL[statesByRef.size % CATEGORICAL.length],
    });
    return id;
  };

  for (const item of byKind('states')) {
    if (item.csv) {
      for (const row of item.csv.rows) {
        registerState(pick(row, 'id') ?? pick(row, 'state'), pick(row, 'state', 'name'), pick(row, 'color'));
      }
      log.push(`${item.name}: государств — ${item.csv.rows.length}`);
    } else if (item.json) {
      const features = (item.json.features ?? []) as Feature[];
      for (const feature of features) {
        registerState(
          prop(feature.properties, 'id', 'state') ?? undefined,
          String(prop(feature.properties, 'state', 'name', 'fullname') ?? ''),
          (prop(feature.properties, 'color', 'fill') as string) ?? undefined,
        );
      }
      log.push(`${item.name}: государств — ${features.length}`);
    }
  }

  /* --- ячейки (map.geojson) --- */
  const cellsFile = byKind('cells')[0];
  if (cellsFile?.json) {
    const features = (cellsFile.json.features ?? []) as Feature[];
    world.cells = {
      type: 'FeatureCollection',
      features: features.map((feature, index) => {
        const properties = feature.properties as Record<string, unknown> | null;
        const cultureId = refId('culture', prop(properties, 'culture'));
        const stateId = registerState(prop(properties, 'state'));
        const cellProps: CellProperties = {
          id: String(refId('cell', prop(properties, 'id')) ?? `cell-${index}`),
          height: numberFrom(prop(properties, 'height', 'elevation')),
          biome: biomeName(prop(properties, 'biome')),
          cultureId,
          religionId: refId('religion', prop(properties, 'religion')),
          languageId: cultureId ? cultureLanguage.get(cultureId) : undefined,
          stateId,
          provinceId: refId('province', prop(properties, 'province')),
          regionId: refId('province', prop(properties, 'province')),
          population: numberFrom(prop(properties, 'population', 'pop')),
        };
        const type = prop(properties, 'type');
        if (type) cellProps.type = String(type);
        return { type: 'Feature', geometry: feature.geometry, properties: cellProps } as Feature<Geometry, CellProperties>;
      }),
    };
    log.push(`${cellsFile.name}: ячеек — ${world.cells.features.length}`);
  }

  /* --- регионы: провинции > государства > ячейки --- */
  const provincesFile = byKind('provinces').find((item) => item.json);
  const statesGeo = byKind('states').find((item) => item.json);

  if (provincesFile?.json) {
    const features = (provincesFile.json.features ?? []) as Feature[];
    world.regions = {
      type: 'FeatureCollection',
      features: features.map((feature, index) => {
        const properties = feature.properties as Record<string, unknown> | null;
        const stateRaw = prop(properties, 'state', 'stateid');
        const stateId = registerState(stateRaw, typeof stateRaw === 'string' ? stateRaw : undefined);
        const regionProps: RegionProperties = {
          id: String(refId('province', prop(properties, 'id', 'province')) ?? `region-${index}`),
          name: String(prop(properties, 'fullname', 'province', 'name') ?? `Регион ${index + 1}`),
          stateId,
        };
        return { type: 'Feature', geometry: feature.geometry, properties: regionProps } as Feature<Geometry, RegionProperties>;
      }),
    };
    log.push(`${provincesFile.name}: регионов (провинций) — ${world.regions.features.length}`);
  } else if (statesGeo?.json) {
    const features = (statesGeo.json.features ?? []) as Feature[];
    world.regions = {
      type: 'FeatureCollection',
      features: features.map((feature, index) => {
        const properties = feature.properties as Record<string, unknown> | null;
        const stateId = registerState(prop(properties, 'id', 'state'), String(prop(properties, 'state', 'name') ?? ''));
        const regionProps: RegionProperties = {
          id: `region-${stateId ?? index}`,
          name: String(prop(properties, 'state', 'name', 'fullname') ?? `Регион ${index + 1}`),
          stateId,
        };
        return { type: 'Feature', geometry: feature.geometry, properties: regionProps } as Feature<Geometry, RegionProperties>;
      }),
    };
    log.push(`${statesGeo.name}: регионы построены по государствам — ${world.regions.features.length}`);
  }

  /* --- точки --- */
  const bbox = boundsOf(world.cells.features);

  for (const item of byKind('burgs')) {
    if (item.json) {
      const features = (item.json.features ?? []) as Feature<Point>[];
      for (const [index, feature] of features.entries()) {
        const properties = feature.properties as Record<string, unknown> | null;
        const coordinates = feature.geometry?.coordinates;
        if (!coordinates) continue;
        world.points.burgs.push({
          id: String(refId('burg', prop(properties, 'id')) ?? `burg-${index}`),
          name: String(prop(properties, 'name', 'burg') ?? `Город ${index + 1}`),
          x: coordinates[0],
          y: coordinates[1],
          population: numberFrom(prop(properties, 'population', 'pop')),
          capital: Boolean(prop(properties, 'capital')),
          port: Boolean(prop(properties, 'port')),
          stateId: refId('state', prop(properties, 'state')),
          cultureId: refId('culture', prop(properties, 'culture')),
          religionId: refId('religion', prop(properties, 'religion')),
        });
      }
      log.push(`${item.name}: городов — ${features.length}`);
    } else if (item.csv) {
      const converted = csvPointsToLonLat(item.csv, bbox);
      for (const [index, entry] of converted.entries()) {
        const row = entry.row;
        const burg: Burg = {
          id: String(refId('burg', pick(row, 'id')) ?? `burg-${index}`),
          name: pick(row, 'burg', 'name', 'city') ?? `Город ${index + 1}`,
          x: entry.lon,
          y: entry.lat,
          height: pickNumber(row, 'elevation (ft)', 'elevation (m)', 'elevation', 'height'),
          population: pickNumber(row, 'population'),
          capital: pickBool(row, 'capital'),
          port: pickBool(row, 'port'),
          stateId: refId('state', pick(row, 'state')),
          cultureId: refId('culture', pick(row, 'culture')),
          religionId: refId('religion', pick(row, 'religion')),
        };
        world.points.burgs.push(burg);
      }
      log.push(`${item.name}: городов — ${converted.length}`);
    }
  }

  for (const item of byKind('markers')) {
    if (item.json) {
      const features = (item.json.features ?? []) as Feature<Point>[];
      for (const [index, feature] of features.entries()) {
        const properties = feature.properties as Record<string, unknown> | null;
        const coordinates = feature.geometry?.coordinates;
        if (!coordinates) continue;
        const note = prop(properties, 'note', 'legend', 'description');
        world.points.markers.push({
          id: String(refId('marker', prop(properties, 'id')) ?? `marker-${index}`),
          name: String(prop(properties, 'name', 'type') ?? note ?? `Метка ${index + 1}`),
          x: coordinates[0],
          y: coordinates[1],
          type: prop(properties, 'type') ? String(prop(properties, 'type')) : undefined,
          icon: prop(properties, 'icon') ? String(prop(properties, 'icon')) : undefined,
          note: note ? String(note) : undefined,
        });
      }
      log.push(`${item.name}: меток — ${features.length}`);
    } else if (item.csv) {
      const converted = csvPointsToLonLat(item.csv, bbox);
      for (const [index, entry] of converted.entries()) {
        const marker: MarkerPoint = {
          id: String(refId('marker', pick(entry.row, 'id')) ?? `marker-${index}`),
          name: pick(entry.row, 'name', 'type', 'marker') ?? `Метка ${index + 1}`,
          x: entry.lon,
          y: entry.lat,
          type: pick(entry.row, 'type'),
          note: pick(entry.row, 'note', 'legend', 'description'),
        };
        world.points.markers.push(marker);
      }
      log.push(`${item.name}: меток — ${converted.length}`);
    }
  }

  /* --- реки и дороги из GIS-экспорта --- */
  const lineLayer = (kind: 'rivers' | 'routes'): void => {
    const file = byKind(kind === 'rivers' ? 'rivers' : 'routes')[0];
    if (!file?.json) return;
    const features = ((file.json.features ?? []) as Feature[]).filter(
      (feature) => feature.geometry && feature.geometry.type !== 'Point',
    );
    if (features.length === 0) return;
    world.layers[kind] = {
      type: 'FeatureCollection',
      features: features.map((feature, index) => {
        const properties = feature.properties as Record<string, unknown> | null;
        const base = {
          id: String(refId(kind === 'rivers' ? 'river' : 'route', prop(properties, 'id')) ?? `${kind}-${index}`),
          name: prop(properties, 'name', 'river', 'route') ? String(prop(properties, 'name', 'river', 'route')) : undefined,
        };
        const extra =
          kind === 'rivers'
            ? {
                type: prop(properties, 'type') ? String(prop(properties, 'type')) : undefined,
                width: numberFrom(prop(properties, 'width')),
                discharge: numberFrom(prop(properties, 'discharge', 'flux')),
              }
            : { group: String(prop(properties, 'group', 'type') ?? 'roads') };
        return { type: 'Feature', geometry: feature.geometry, properties: { ...base, ...extra } } as never;
      }),
    };
    log.push(`${file.name}: ${kind === 'rivers' ? 'рек' : 'дорог'} — ${features.length}`);
  };
  lineLayer('rivers');
  lineLayer('routes');

  /* --- досбор справочников по данным ячеек --- */
  for (const feature of world.cells.features) {
    const { cultureId, religionId, languageId, biome } = feature.properties;
    if (cultureId && !culturesByRef.has(cultureId)) culturesByRef.set(cultureId, { id: cultureId, name: cultureId });
    if (religionId && !religionsByRef.has(religionId)) religionsByRef.set(religionId, { id: religionId, name: religionId });
    if (languageId && !languagesByRef.has(languageId)) languagesByRef.set(languageId, { id: languageId, name: languageId });
    if (biome) {
      const id = `biome-${slugify(String(biome), 'b')}`;
      if (!world.dictionaries.biomes.some((entry) => entry.id === id)) {
        world.dictionaries.biomes.push({ id, name: String(biome) });
      }
    }
  }

  world.dictionaries.cultures = [...culturesByRef.values()];
  world.dictionaries.religions = [...religionsByRef.values()];
  world.dictionaries.languages = [...languagesByRef.values()];
  world.timeline.states = [...statesByRef.values()];

  // ветры по умолчанию как в FMG: 6 широтных полос
  world.layers.winds = { bands: [225, 45, 225, 315, 135, 315] };

  // стартовый snapshot = текущая политическая карта
  if (world.regions.features.length > 0 || world.cells.features.length > 0) {
    const regions =
      world.regions.features.length > 0
        ? world.regions.features
        : world.cells.features.map((f) => ({ properties: { id: f.properties.id, stateId: f.properties.stateId } }));
    const regionState: Record<string, string> = {};
    for (const region of regions) {
      const stateId = (region.properties as RegionProperties).stateId;
      if (stateId) regionState[(region.properties as RegionProperties).id] = stateId;
    }
    world.timeline.snapshots = [
      { id: 'snap-present', date: '0', label: 'Настоящее', regionState, notes: 'Импортировано из Azgaar FMG' },
    ];
  }

  const normalized = normalizeWorld(world);
  log.push(
    `Итого: ячеек ${normalized.cells.features.length}, регионов ${normalized.regions.features.length}, ` +
      `государств ${normalized.timeline.states.length}, городов ${normalized.points.burgs.length}, ` +
      `меток ${normalized.points.markers.length}`,
  );
  return { world: normalized, log };
}

function guessWorldName(files: File[]): string {
  const cellsFile = files.find((file) => file.name.toLowerCase().includes('cell')) ?? files[0];
  if (!cellsFile) return 'Мир из Azgaar';
  return cellsFile.name.replace(/\.(geo)?json$|\.csv$/i, '').replace(/[_-]?cells?$/i, '') || 'Мир из Azgaar';
}

function boundsOf(features: Feature<Geometry, unknown>[]): [number, number, number, number] | null {
  if (features.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [x, y] = coords as Position;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const item of coords) walk(item);
  };
  for (const feature of features) {
    if (feature.geometry && 'coordinates' in feature.geometry) {
      walk((feature.geometry as { coordinates: unknown }).coordinates);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

interface ConvertedPoint {
  row: Record<string, string>;
  lon: number;
  lat: number;
}

/**
 * В CSV Azgaar координаты бывают двух видов: Latitude/Longitude (новые версии)
 * или x/y в пикселях карты (старые). Пиксели линейно натягиваются на bbox ячеек
 * с переворотом оси Y — точного соответствия без размеров исходной карты не получить.
 */
function csvPointsToLonLat(csv: CsvTable, bbox: [number, number, number, number] | null): ConvertedPoint[] {
  const rows = csv.rows;
  const hasLatLon = rows.some((row) => pick(row, 'latitude', 'lat') !== undefined && pick(row, 'longitude', 'lon', 'lng') !== undefined);

  if (hasLatLon) {
    return rows
      .map((row) => {
        const lat = pickNumber(row, 'latitude', 'lat');
        const lon = pickNumber(row, 'longitude', 'lon', 'lng');
        return lat === undefined || lon === undefined ? null : { row, lon, lat };
      })
      .filter((item): item is ConvertedPoint => item !== null);
  }

  const raw = rows
    .map((row) => {
      const x = pickNumber(row, 'x');
      const y = pickNumber(row, 'y');
      return x === undefined || y === undefined ? null : { row, x, y };
    })
    .filter((item): item is { row: Record<string, string>; x: number; y: number } => item !== null);

  if (raw.length === 0 || !bbox) return [];

  const xs = raw.map((item) => item.x);
  const ys = raw.map((item) => item.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const [bMinX, bMinY, bMaxX, bMaxY] = bbox;

  return raw.map((item) => ({
    row: item.row,
    lon: bMinX + ((item.x - minX) / spanX) * (bMaxX - bMinX),
    lat: bMaxY - ((item.y - minY) / spanY) * (bMaxY - bMinY),
  }));
}

export { centroidOf };
