/**
 * Импорт «Full JSON» из Azgaar's Fantasy Map Generator (Export -> JSON -> Full).
 *
 * Это не GIS-экспорт: внутри лежит вся модель FMG, включая саму сетку Voronoi
 * (pack.cells[].v -> pack.vertices[].p), справочники, города, метки, растровую
 * сетку высот и настройки эры. Поэтому геометрия получается «родная», органическая,
 * а не квадраты — ровно то, что нужно для рисуемых границ.
 *
 * Координаты в файле пиксельные (info.width x info.height); переводятся в градусы
 * через mapCoordinates, как это делает сам FMG при GIS-экспорте.
 */
import type { Feature, Geometry, Position } from 'geojson';
import { dissolveByKey } from '../util/dissolve';
import { slugify } from '../util/id';
import {
  SCHEMA_VERSION,
  type Burg,
  type CellProperties,
  type DictEntry,
  type HeightGrid,
  type MarkerPoint,
  type RegionProperties,
  type RiverProperties,
  type RouteProperties,
  type StateDef,
  type TimelineEvent,
  type World,
  type ZoneProperties,
} from '../state/types';

interface FmgInfo {
  version?: string;
  mapName?: string;
  width?: number;
  height?: number;
  exportedAt?: string;
  seed?: string;
}

interface FmgMapCoordinates {
  latT: number;
  latN: number;
  latS: number;
  lonT: number;
  lonW: number;
  lonE: number;
}

interface FmgCell {
  i: number;
  v: number[];
  c?: number[];
  p?: [number, number];
  h?: number;
  biome?: number;
  pop?: number;
  culture?: number;
  religion?: number;
  state?: number;
  province?: number;
  t?: number;
}

interface FmgVertex {
  i: number;
  p: [number, number];
}

interface FmgNamed {
  i: number;
  name?: string;
  fullName?: string;
  formName?: string;
  color?: string;
  type?: string;
  form?: string;
  base?: number;
  state?: number;
  removed?: boolean;
  campaigns?: Array<{ name?: string; start?: number; end?: number }>;
}

interface FmgBurg {
  i: number;
  name?: string;
  x?: number;
  y?: number;
  cell?: number;
  state?: number;
  culture?: number;
  religion?: number;
  capital?: number;
  port?: number;
  population?: number;
  type?: string;
  removed?: boolean;
}

interface FmgMarker {
  i: number;
  x?: number;
  y?: number;
  type?: string;
  icon?: string;
  cell?: number;
}

interface FmgNote {
  id?: string;
  name?: string;
  legend?: string;
}

interface FmgRiver {
  i: number;
  name?: string;
  type?: string;
  cells?: number[];
  width?: number;
  widthFactor?: number;
  discharge?: number;
}

interface FmgRoute {
  i: number;
  name?: string;
  group?: string;
  points?: Array<[number, number] | [number, number, number]>;
}

interface FmgZone {
  i: number;
  name?: string;
  type?: string;
  color?: string;
  cells?: number[];
}

interface FmgFull {
  info?: FmgInfo;
  settings?: { options?: { winds?: number[]; year?: number; era?: string; eraShort?: string } };
  mapCoordinates?: FmgMapCoordinates;
  pack?: {
    cells?: FmgCell[];
    vertices?: FmgVertex[];
    biomes?: Array<{ i: number; name?: string; color?: string }>;
    cultures?: FmgNamed[];
    religions?: FmgNamed[];
    states?: FmgNamed[];
    provinces?: FmgNamed[];
    burgs?: FmgBurg[];
    markers?: FmgMarker[];
    rivers?: FmgRiver[];
    routes?: FmgRoute[];
    zones?: FmgZone[];
  };
  grid?: { cells?: Array<{ h?: number }>; cellsX?: number; cellsY?: number };
  notes?: FmgNote[];
  nameBases?: Array<{ name?: string }>;
}

/** Отличительные признаки полного дампа FMG. */
export function isFmgFullJson(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as FmgFull;
  return Boolean(candidate.pack?.cells && candidate.pack?.vertices && candidate.info);
}

export interface FmgImportResult {
  world: World;
  log: string[];
}

export function importFmgFull(raw: unknown): FmgImportResult {
  const data = raw as FmgFull;
  const pack = data.pack;
  const cells = pack?.cells ?? [];
  const vertices = pack?.vertices ?? [];
  if (cells.length === 0 || vertices.length === 0) {
    throw new Error('В файле нет pack.cells / pack.vertices — это не полный экспорт FMG');
  }

  const log: string[] = [];
  const width = data.info?.width ?? 1000;
  const height = data.info?.height ?? 1000;
  const coordinates: FmgMapCoordinates =
    data.mapCoordinates ?? { latT: 180, latN: 90, latS: -90, lonT: 360, lonW: -180, lonE: 180 };

  /** пиксели карты FMG -> градусы (так же считает сам GIS-экспорт FMG) */
  const toLonLat = (x: number, y: number): Position => [
    coordinates.lonW + (x / width) * coordinates.lonT,
    coordinates.latN - (y / height) * coordinates.latT,
  ];

  /* ---------------- справочники ---------------- */

  const biomeNames = new Map<number, string>();
  const biomes: DictEntry[] = [];
  for (const biome of pack?.biomes ?? []) {
    const name = biome.name ?? `Biome ${biome.i}`;
    biomeNames.set(biome.i, name);
    biomes.push({ id: `biome-${slugify(name, String(biome.i))}`, name, color: biome.color });
  }

  const nameBases = data.nameBases ?? [];
  const languages = new Map<string, DictEntry>();
  const cultureLanguage = new Map<string, string>();
  const cultures: DictEntry[] = [];
  for (const culture of pack?.cultures ?? []) {
    if (culture.removed) continue;
    const id = `culture-${culture.i}`;
    cultures.push({ id, name: culture.name ?? id, color: culture.color, note: culture.type });
    const baseName = typeof culture.base === 'number' ? nameBases[culture.base]?.name : undefined;
    if (baseName) {
      const languageId = `language-${slugify(baseName, 'lang')}`;
      if (!languages.has(languageId)) languages.set(languageId, { id: languageId, name: baseName });
      cultureLanguage.set(id, languageId);
    }
  }

  const religions: DictEntry[] = [];
  for (const religion of pack?.religions ?? []) {
    if (religion.removed) continue;
    religions.push({
      id: `religion-${religion.i}`,
      name: religion.name ?? `religion-${religion.i}`,
      color: religion.color,
      note: [religion.type, religion.form].filter(Boolean).join(' · ') || undefined,
    });
  }

  const states: StateDef[] = [];
  const statePalette = ['#b8474f', '#3f7ecf', '#5f9e50', '#c9a227', '#9b59b6', '#cf7a3f'];
  for (const state of pack?.states ?? []) {
    if (state.i === 0 || state.removed) continue; // 0 = Neutrals, «ничьё»
    states.push({
      id: `state-${state.i}`,
      name: state.fullName || state.name || `state-${state.i}`,
      color: state.color ?? statePalette[state.i % statePalette.length],
      note: state.type,
    });
  }

  /* ---------------- регионы (провинции FMG) ---------------- */

  const regions: Feature<Geometry, RegionProperties>[] = [];
  const knownRegions = new Set<string>();
  for (const province of pack?.provinces ?? []) {
    if (!province || province.i === 0 || province.removed) continue;
    const id = `province-${province.i}`;
    knownRegions.add(id);
    regions.push({
      type: 'Feature',
      // геометрия регионов выводится из ячеек (regionSource: 'cells'),
      // поэтому здесь пустой MultiPolygon — он заполняется при экспорте/отрисовке
      geometry: { type: 'MultiPolygon', coordinates: [] },
      properties: {
        id,
        name: province.fullName || province.name || id,
        stateId: province.state ? `state-${province.state}` : undefined,
        color: province.color,
      },
    });
  }

  /* ---------------- ячейки ---------------- */

  const features: Feature<Geometry, CellProperties>[] = [];
  const extraRegions = new Map<string, string>(); // stateId -> regionId для ячеек без провинции
  let skipped = 0;

  for (const cell of cells) {
    const ring: Position[] = [];
    for (const vertexIndex of cell.v) {
      const point = vertices[vertexIndex]?.p;
      if (!point) continue;
      ring.push(toLonLat(point[0], point[1]));
    }
    if (ring.length < 3) {
      skipped += 1;
      continue;
    }
    ring.push([...ring[0]] as Position);

    const cultureId = cell.culture ? `culture-${cell.culture}` : undefined;
    const stateId = cell.state ? `state-${cell.state}` : undefined;
    let regionId = cell.province ? `province-${cell.province}` : undefined;
    if (regionId && !knownRegions.has(regionId)) regionId = undefined;
    if (!regionId && stateId) {
      // земли государства без провинции сводим в один «коренной» регион
      let synthetic = extraRegions.get(stateId);
      if (!synthetic) {
        synthetic = `region-${stateId}-core`;
        extraRegions.set(stateId, synthetic);
        knownRegions.add(synthetic);
        regions.push({
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: [] },
          properties: {
            id: synthetic,
            name: `${states.find((item) => item.id === stateId)?.name ?? stateId}: коренные земли`,
            stateId,
          },
        });
      }
      regionId = synthetic;
    }

    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        id: `cell-${cell.i}`,
        height: cell.h ?? 0,
        biome: biomeNames.get(cell.biome ?? 0) ?? String(cell.biome ?? ''),
        cultureId,
        religionId: cell.religion ? `religion-${cell.religion}` : undefined,
        languageId: cultureId ? cultureLanguage.get(cultureId) : undefined,
        stateId,
        provinceId: cell.province ? `province-${cell.province}` : undefined,
        regionId,
        population: cell.pop !== undefined ? Math.round(cell.pop * 100) / 100 : undefined,
      },
    });
  }
  if (skipped > 0) log.push(`Пропущено ячеек без геометрии: ${skipped}`);

  /* ---------------- точки ---------------- */

  const burgs: Burg[] = [];
  for (const burg of pack?.burgs ?? []) {
    if (!burg || burg.removed || burg.x === undefined || burg.y === undefined) continue;
    if (!burg.name && burg.i === 0) continue; // нулевой burg — заглушка FMG
    const [lon, lat] = toLonLat(burg.x, burg.y);
    burgs.push({
      id: `burg-${burg.i}`,
      name: burg.name ?? `burg-${burg.i}`,
      x: lon,
      y: lat,
      population: burg.population !== undefined ? Math.round(burg.population * 1000) : undefined,
      capital: Boolean(burg.capital),
      port: Boolean(burg.port),
      stateId: burg.state ? `state-${burg.state}` : undefined,
      cultureId: burg.culture ? `culture-${burg.culture}` : undefined,
      religionId: burg.religion ? `religion-${burg.religion}` : undefined,
      note: burg.type,
    });
  }

  const notes = new Map<string, FmgNote>();
  for (const note of data.notes ?? []) {
    if (note?.id) notes.set(note.id, note);
  }

  const markers: MarkerPoint[] = [];
  for (const marker of pack?.markers ?? []) {
    if (!marker || marker.x === undefined || marker.y === undefined) continue;
    const [lon, lat] = toLonLat(marker.x, marker.y);
    const note = notes.get(`marker${marker.i}`);
    markers.push({
      id: `marker-${marker.i}`,
      name: note?.name ?? marker.type ?? `marker-${marker.i}`,
      x: lon,
      y: lat,
      type: marker.type,
      icon: marker.icon,
      note: note?.legend?.replace(/\r\n/g, '\n'),
    });
  }

  /* ---------------- реки, дороги, зоны ---------------- */

  const cellById = new Map<number, FmgCell>();
  for (const cell of cells) cellById.set(cell.i, cell);

  // реки в FMG заданы цепочкой ячеек — линию ведём по их центрам
  const riverFeatures: Array<Feature<Geometry, RiverProperties>> = [];
  for (const river of pack?.rivers ?? []) {
    const points: Position[] = [];
    for (const cellIndex of river.cells ?? []) {
      const point = cellById.get(cellIndex)?.p;
      if (point) points.push(toLonLat(point[0], point[1]));
    }
    if (points.length < 2) continue;
    riverFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points },
      properties: {
        id: `river-${river.i}`,
        name: river.name,
        type: river.type,
        width: river.width !== undefined ? river.width * (river.widthFactor ?? 1) : undefined,
        discharge: river.discharge,
      },
    });
  }

  const routeFeatures: Array<Feature<Geometry, RouteProperties>> = [];
  for (const route of pack?.routes ?? []) {
    const points = (route.points ?? [])
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map((point) => toLonLat(point[0], point[1]));
    if (points.length < 2) continue;
    routeFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points },
      properties: { id: `route-${route.i}`, name: route.name, group: route.group ?? 'roads' },
    });
  }

  // зоны заданы набором ячеек: собираем их геометрию тем же растворением границ
  const zoneFeatures: Array<Feature<Geometry, ZoneProperties>> = [];
  const cellFeatureById = new Map<string, Feature<Geometry, CellProperties>>();
  for (const feature of features) cellFeatureById.set(feature.properties.id, feature);
  for (const zone of pack?.zones ?? []) {
    const members = (zone.cells ?? [])
      .map((cellIndex) => cellFeatureById.get(`cell-${cellIndex}`))
      .filter((item): item is Feature<Geometry, CellProperties> => Boolean(item));
    if (members.length === 0) continue;
    const dissolved = dissolveByKey(members, () => 'zone');
    const coordinates = dissolved.get('zone');
    if (!coordinates || coordinates.length === 0) continue;
    zoneFeatures.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates },
      properties: {
        id: `zone-${zone.i}`,
        name: zone.name,
        type: zone.type,
        // цвет может быть ссылкой на SVG-паттерн (url(#hatch1)) — такой не годится
        color: zone.color && zone.color.startsWith('#') ? zone.color : undefined,
      },
    });
  }

  if (riverFeatures.length || routeFeatures.length || zoneFeatures.length) {
    log.push(`Реки ${riverFeatures.length}, дороги ${routeFeatures.length}, зоны ${zoneFeatures.length}`);
  }

  /* ---------------- растровая сетка высот ---------------- */

  let heightmap: HeightGrid | undefined;
  const gridCells = data.grid?.cells;
  const gridX = data.grid?.cellsX;
  const gridY = data.grid?.cellsY;
  if (Array.isArray(gridCells) && gridX && gridY && gridCells.length >= gridX * gridY) {
    const values: number[] = new Array(gridX * gridY);
    for (let i = 0; i < gridX * gridY; i++) values[i] = gridCells[i]?.h ?? 0;
    heightmap = {
      width: gridX,
      height: gridY,
      bbox: [coordinates.lonW, coordinates.latS, coordinates.lonE, coordinates.latN],
      values,
      min: 0,
      max: 100,
    };
    log.push(`Растровый рельеф: сетка ${gridX}x${gridY}`);
  }

  /* ---------------- таймлайн ---------------- */

  const options = data.settings?.options ?? {};
  const year = typeof options.year === 'number' ? options.year : 0;
  const regionState: Record<string, string> = {};
  for (const region of regions) {
    if (region.properties.stateId) regionState[region.properties.id] = region.properties.stateId;
  }

  const events: TimelineEvent[] = [];
  const seen = new Set<string>();
  for (const state of pack?.states ?? []) {
    for (const campaign of state.campaigns ?? []) {
      if (!campaign?.name || typeof campaign.start !== 'number') continue;
      const key = `${campaign.name}|${campaign.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const attacker = state.fullName || state.name || `state-${state.i}`;
      events.push({
        id: `ev-campaign-${state.i}-${campaign.start}-${events.length}`,
        date: String(campaign.start),
        title: campaign.name,
        description: `${attacker}${campaign.end ? `, до ${campaign.end}` : ''}`,
      });
    }
  }
  if (events.length > 0) log.push(`Военные кампании FMG превращены в события: ${events.length}`);

  const now = new Date().toISOString();
  const world: World = {
    meta: {
      name: data.info?.mapName || 'Мир из Azgaar',
      createdAt: data.info?.exportedAt ?? now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
      projection: 'equirectangular',
      seaLevel: 20,
      regionSource: 'cells',
      era: options.eraShort ? { positive: options.eraShort } : undefined,
      description: [data.info?.mapName, options.era, data.info?.version && `FMG ${data.info.version}`]
        .filter(Boolean)
        .join(' · '),
      source: 'azgaar-full-json',
    },
    cells: { type: 'FeatureCollection', features },
    regions: { type: 'FeatureCollection', features: regions },
    layers: {
      heightmap,
      winds: options.winds?.length ? { bands: options.winds } : { bands: [225, 45, 225, 315, 135, 315] },
      rivers: riverFeatures.length ? { type: 'FeatureCollection', features: riverFeatures } : undefined,
      routes: routeFeatures.length ? { type: 'FeatureCollection', features: routeFeatures } : undefined,
      zones: zoneFeatures.length ? { type: 'FeatureCollection', features: zoneFeatures } : undefined,
    },
    points: { burgs, markers },
    timeline: {
      snapshots: [
        {
          id: 'snap-present',
          date: String(year),
          label: options.era || 'Настоящее',
          regionState,
          notes: 'Импортировано из полного JSON Azgaar FMG',
        },
      ],
      events,
      states,
    },
    dictionaries: { cultures, religions, languages: [...languages.values()], biomes },
  };

  log.push(
    `Ячеек ${features.length}, регионов ${regions.length}, государств ${states.length}, ` +
      `городов ${burgs.length}, меток ${markers.length}, культур ${cultures.length}, религий ${religions.length}`,
  );
  return { world, log };
}
