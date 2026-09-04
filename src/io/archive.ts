import JSZip from 'jszip';
import { baseRegionGeometries } from '../state/topology';
import type { RegionCollection, World } from '../state/types';
import { normalizeWorld, ValidationError } from './validate';

/**
 * Раскладка архива мира (раздел 4 ТЗ):
 *
 *   meta.json
 *   map.geojson              — ячейки/полигоны тематической карты
 *   regions.geojson          — политические единицы для таймлайна
 *   layers/heightmap.json | winds.json | cultures.geojson | religions.geojson | languages.geojson
 *   points/burgs.json | markers.json
 *   timeline/snapshots.json | events.json | states.json
 *   dictionaries/cultures.json | religions.json | languages.json | biomes.json
 */

const README = `Worldbuilder Atlas — архив мира
================================
Это обычный zip с JSON-файлами. Его можно править руками, класть в git,
передавать между машинами. Приложение не хранит данные нигде, кроме этого файла
(и черновика в IndexedDB браузера).

meta.json            метаданные и schemaVersion
map.geojson          FeatureCollection ячеек: height, biome, cultureId, religionId, languageId
regions.geojson      FeatureCollection политических регионов (id, name, stateId)
layers/              heightmap.json, winds.json + тематические GeoJSON-слои
points/              burgs.json, markers.json — координаты x/y в системе map.geojson
timeline/            snapshots.json (regionId -> stateId по датам), events.json, states.json
dictionaries/        справочники культур, религий, языков, биомов с цветами
`;

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Если регионы собраны из ячеек, их геометрия в модели пустая (считается на лету).
 * В архив пишем уже посчитанные полигоны базовой карты, чтобы regions.geojson
 * оставался самостоятельным валидным GeoJSON — его можно открыть в QGIS.
 * Границы по эпохам живут в timeline/snapshots.json (поле geo) и не теряются.
 */
function regionsForExport(world: World): RegionCollection {
  if (world.meta.regionSource === 'geometry') return world.regions;
  const geometries = baseRegionGeometries(world);
  return {
    type: 'FeatureCollection',
    features: world.regions.features.map((feature) => {
      const coordinates = geometries.get(feature.properties.id) ?? [];
      return {
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates },
        properties: feature.properties,
      };
    }),
  } as RegionCollection;
}

export async function exportWorldZip(world: World): Promise<Blob> {
  const zip = new JSZip();

  zip.file('README.txt', README);
  zip.file('meta.json', json({ ...world.meta, updatedAt: new Date().toISOString() }));
  zip.file('map.geojson', json(world.cells));
  zip.file('regions.geojson', json(regionsForExport(world)));

  const layers = zip.folder('layers')!;
  if (world.layers.heightmap) layers.file('heightmap.json', json(world.layers.heightmap));
  if (world.layers.winds) layers.file('winds.json', json(world.layers.winds));
  if (world.layers.cultures) layers.file('cultures.geojson', json(world.layers.cultures));
  if (world.layers.religions) layers.file('religions.geojson', json(world.layers.religions));
  if (world.layers.languages) layers.file('languages.geojson', json(world.layers.languages));
  if (world.layers.rivers) layers.file('rivers.geojson', json(world.layers.rivers));
  if (world.layers.routes) layers.file('routes.geojson', json(world.layers.routes));
  if (world.layers.zones) layers.file('zones.geojson', json(world.layers.zones));
  if (world.layers.currents) layers.file('currents.geojson', json(world.layers.currents));

  const points = zip.folder('points')!;
  points.file('burgs.json', json(world.points.burgs));
  points.file('markers.json', json(world.points.markers));

  const timeline = zip.folder('timeline')!;
  timeline.file('snapshots.json', json(world.timeline.snapshots));
  timeline.file('events.json', json(world.timeline.events));
  timeline.file('states.json', json(world.timeline.states));

  const dictionaries = zip.folder('dictionaries')!;
  dictionaries.file('cultures.json', json(world.dictionaries.cultures));
  dictionaries.file('religions.json', json(world.dictionaries.religions));
  dictionaries.file('languages.json', json(world.dictionaries.languages));
  dictionaries.file('biomes.json', json(world.dictionaries.biomes));

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Ищет файл по имени вне зависимости от вложенности (архив мог быть перепакован с папкой). */
function findFile(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const direct = zip.file(path);
  if (direct) return direct;
  const suffix = `/${path}`;
  const matches = zip.file(new RegExp(`(^|/)${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  if (matches.length > 0) return matches[0];
  const all = Object.keys(zip.files).find((name) => name.endsWith(suffix));
  return all ? zip.file(all) : null;
}

async function readJson(zip: JSZip, path: string): Promise<unknown | undefined> {
  const file = findFile(zip, path);
  if (!file) return undefined;
  const text = await file.async('string');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`${path}: невалидный JSON (${(error as Error).message})`);
  }
}

export async function importWorldZip(file: Blob): Promise<World> {
  const zip = await JSZip.loadAsync(file);

  const raw = {
    meta: await readJson(zip, 'meta.json'),
    cells: await readJson(zip, 'map.geojson'),
    regions: await readJson(zip, 'regions.geojson'),
    layers: {
      heightmap: await readJson(zip, 'layers/heightmap.json'),
      winds: await readJson(zip, 'layers/winds.json'),
      cultures: await readJson(zip, 'layers/cultures.geojson'),
      religions: await readJson(zip, 'layers/religions.geojson'),
      languages: await readJson(zip, 'layers/languages.geojson'),
      rivers: await readJson(zip, 'layers/rivers.geojson'),
      routes: await readJson(zip, 'layers/routes.geojson'),
      zones: await readJson(zip, 'layers/zones.geojson'),
      currents: await readJson(zip, 'layers/currents.geojson'),
    },
    points: {
      burgs: await readJson(zip, 'points/burgs.json'),
      markers: await readJson(zip, 'points/markers.json'),
    },
    timeline: {
      snapshots: await readJson(zip, 'timeline/snapshots.json'),
      events: await readJson(zip, 'timeline/events.json'),
      states: await readJson(zip, 'timeline/states.json'),
    },
    dictionaries: {
      cultures: await readJson(zip, 'dictionaries/cultures.json'),
      religions: await readJson(zip, 'dictionaries/religions.json'),
      languages: await readJson(zip, 'dictionaries/languages.json'),
      biomes: await readJson(zip, 'dictionaries/biomes.json'),
    },
  };

  if (!raw.meta && !raw.cells && !raw.regions) {
    throw new ValidationError('Это не архив мира: нет ни meta.json, ни map.geojson');
  }

  return normalizeWorld(raw);
}

/** Импорт цельного JSON-дампа модели (альтернатива zip). */
export function importWorldJson(text: string): World {
  return normalizeWorld(JSON.parse(text));
}

export function worldToJson(world: World): string {
  return json(world);
}
