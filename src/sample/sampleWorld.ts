/**
 * Демо-мир: генерируется в браузере, чтобы приложение было чем занять до импорта.
 * Никакой связи с боевым пайплайном — просто данные, уложенные во внутреннюю схему.
 */
import type { Feature, Geometry } from 'geojson';
import { CATEGORICAL } from '../map/colors';
import { buildVoronoiMesh } from '../util/mesh';
import { biomeForConditions } from '../util/biome';
import { mulberry32 } from '../util/random';
import {
  SCHEMA_VERSION,
  type Burg,
  type CellProperties,
  type DictEntry,
  type HeightGrid,
  type MarkerPoint,
  type RegionProperties,
  type Snapshot,
  type StateDef,
  type TimelineEvent,
  type World,
} from '../state/types';

const LON_MIN = -100;
const LON_MAX = 100;
const LAT_MIN = -50;
const LAT_MAX = 50;
const COLS = 40;
const ROWS = 24;

const CULTURES: DictEntry[] = [
  { id: 'culture-veran', name: 'Веранцы', color: '#e06c75' },
  { id: 'culture-solmar', name: 'Солмарцы', color: '#61afef' },
  { id: 'culture-kadesh', name: 'Кадеши', color: '#98c379' },
  { id: 'culture-north', name: 'Северные кланы', color: '#e5c07b' },
  { id: 'culture-isles', name: 'Островитяне', color: '#c678dd' },
  { id: 'culture-sand', name: 'Песчаные племена', color: '#d19a66' },
];

const RELIGIONS: DictEntry[] = [
  { id: 'religion-solar', name: 'Культ Солнца', color: '#e5c07b' },
  { id: 'religion-deep', name: 'Глубинная вера', color: '#56b6c2' },
  { id: 'religion-ancest', name: 'Почитание предков', color: '#98c379' },
  { id: 'religion-void', name: 'Пустотники', color: '#c678dd' },
];

const LANGUAGES: DictEntry[] = [
  { id: 'language-veranic', name: 'Веранская семья', color: '#e06c75' },
  { id: 'language-solmaric', name: 'Солмарская семья', color: '#61afef' },
  { id: 'language-old', name: 'Древние наречия', color: '#98c379' },
];

const STATES: StateDef[] = [
  { id: 'state-empire', name: 'Первая Империя', color: '#b8474f' },
  { id: 'state-solmar', name: 'Солмарская лига', color: '#3f7ecf' },
  { id: 'state-kadesh', name: 'Кадешское царство', color: '#5f9e50' },
  { id: 'state-north', name: 'Северный союз', color: '#c9a227' },
  { id: 'state-isles', name: 'Островная талассократия', color: '#9b59b6' },
  { id: 'state-sand', name: 'Песчаные эмираты', color: '#cf7a3f' },
];

interface Blob {
  lon: number;
  lat: number;
  radius: number;
  amplitude: number;
}

const BLOBS: Blob[] = [
  { lon: -55, lat: 18, radius: 34, amplitude: 78 },
  { lon: -20, lat: 30, radius: 26, amplitude: 62 },
  { lon: 15, lat: 5, radius: 40, amplitude: 88 },
  { lon: 45, lat: -20, radius: 30, amplitude: 70 },
  { lon: -35, lat: -28, radius: 24, amplitude: 58 },
  { lon: 72, lat: 26, radius: 16, amplitude: 52 },
  { lon: -78, lat: -8, radius: 13, amplitude: 48 },
];

function heightAt(lon: number, lat: number): number {
  let height = 4;
  for (const blob of BLOBS) {
    const distance = Math.hypot(lon - blob.lon, (lat - blob.lat) * 1.6);
    if (distance < blob.radius) {
      const falloff = 1 - distance / blob.radius;
      height += blob.amplitude * falloff * falloff;
    }
  }
  return Math.min(100, Math.round(height));
}

function biomeAt(height: number, lat: number): string {
  return biomeForConditions(height, lat, 20, 100);
}

function nearestIndex(lon: number, lat: number, seeds: Array<[number, number]>): number {
  let best = 0;
  let bestDistance = Infinity;
  seeds.forEach(([seedLon, seedLat], index) => {
    const distance = Math.hypot(lon - seedLon, (lat - seedLat) * 1.4);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export function createSampleWorld(): World {
  const random = mulberry32(20260904);
  const lonStep = (LON_MAX - LON_MIN) / COLS;
  const latStep = (LAT_MAX - LAT_MIN) / ROWS;

  const cultureSeeds: Array<[number, number]> = [
    [-55, 20], [-18, 32], [16, 2], [46, -18], [-36, -26], [70, 24],
  ];
  const religionSeeds: Array<[number, number]> = [[-45, 26], [10, -6], [40, 22], [-20, -30]];

  // --- нерегулярная сетка Voronoi: границы получаются «живыми», а не квадратными
  const mesh = buildVoronoiMesh({
    bbox: [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
    count: COLS * ROWS * 2,
    random,
    jitter: 0.45,
  });

  // --- 20 регионов: тоже органические, по ближайшему центру
  const regionNames = [
    'Верхний Веран', 'Приморье', 'Долина Солмар', 'Кадешские холмы', 'Восточный предел',
    'Средний Веран', 'Озёрный край', 'Сердце Кадеша', 'Пепельные степи', 'Дальний берег',
    'Южный Веран', 'Соляные топи', 'Кадешская пустошь', 'Красные пески', 'Штормовые острова',
    'Ледяная марка', 'Северные фьорды', 'Тихий залив', 'Забытые земли', 'Край света',
  ];
  const regionCols = 5;
  const regionRows = 4;
  const regionSeeds: Array<[number, number]> = [];
  for (let row = 0; row < regionRows; row++) {
    for (let column = 0; column < regionCols; column++) {
      const lon = LON_MIN + ((column + 0.5 + (random() - 0.5) * 0.4) / regionCols) * (LON_MAX - LON_MIN);
      const lat = LAT_MAX - ((row + 0.5 + (random() - 0.5) * 0.4) / regionRows) * (LAT_MAX - LAT_MIN);
      regionSeeds.push([lon, lat]);
    }
  }

  const cells: Feature<Geometry, CellProperties>[] = [];
  for (const cell of mesh) {
    const height = heightAt(cell.lon, cell.lat);
    const land = height >= 20;
    const cultureIndex = nearestIndex(cell.lon, cell.lat, cultureSeeds);
    const religionIndex = nearestIndex(cell.lon, cell.lat, religionSeeds);
    const regionIndex = nearestIndex(cell.lon, cell.lat, regionSeeds);

    cells.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [cell.ring] },
      properties: {
        id: `cell-${cell.index}`,
        height,
        biome: biomeAt(height, cell.lat),
        cultureId: land ? CULTURES[cultureIndex].id : undefined,
        religionId: land ? RELIGIONS[religionIndex].id : undefined,
        languageId: land ? LANGUAGES[cultureIndex % LANGUAGES.length].id : undefined,
        regionId: `region-${regionIndex + 1}`,
        population: land ? Math.round(random() * 40 * (height / 40)) : 0,
      },
    });
  }

  // геометрия регионов выводится из ячеек, поэтому в записях она пустая
  const regions: Feature<Geometry, RegionProperties>[] = regionSeeds.map((_seed, index) => ({
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [] },
    properties: {
      id: `region-${index + 1}`,
      name: regionNames[index] ?? `Регион ${index + 1}`,
    },
  }));

  const regionIds = regions.map((region) => region.properties.id);
  const pick = (indices: number[], stateId: string): Record<string, string> =>
    Object.fromEntries(indices.map((index) => [regionIds[index], stateId]));

  const snapshots: Snapshot[] = [
    {
      id: 'snap-1200',
      date: '-1200',
      label: 'Основание Первой Империи',
      regionState: {
        ...pick([5, 6, 10, 11], 'state-empire'),
        ...pick([2, 7], 'state-kadesh'),
        ...pick([0, 1], 'state-north'),
      },
      notes: 'Империя занимает центральные долины, север ещё раздроблен.',
    },
    {
      id: 'snap-800',
      date: '-800',
      label: 'Эпоха расширения',
      regionState: {
        ...pick([5, 6, 10, 11, 12, 7], 'state-empire'),
        ...pick([2, 3], 'state-kadesh'),
        ...pick([0, 1], 'state-north'),
        ...pick([14, 9], 'state-isles'),
      },
    },
    {
      id: 'snap-300',
      date: '-300',
      label: 'Раскол',
      regionState: {
        ...pick([5, 10], 'state-empire'),
        ...pick([6, 11, 12], 'state-solmar'),
        ...pick([2, 3, 7], 'state-kadesh'),
        ...pick([0, 1, 16], 'state-north'),
        ...pick([14, 9, 19], 'state-isles'),
        ...pick([13, 18], 'state-sand'),
      },
      notes: 'Империя распадается на Солмарскую лигу и остатки метрополии.',
    },
    {
      id: 'snap-0',
      date: '0',
      label: 'Год Договора',
      regionState: {
        ...pick([5], 'state-empire'),
        ...pick([6, 10, 11, 12, 7], 'state-solmar'),
        ...pick([2, 3], 'state-kadesh'),
        ...pick([0, 1, 15, 16], 'state-north'),
        ...pick([14, 9, 19], 'state-isles'),
        ...pick([13, 18, 17], 'state-sand'),
      },
    },
    {
      id: 'snap-500',
      date: '500',
      label: 'Новая гегемония',
      regionState: {
        ...pick([5, 6, 10, 11, 12, 7, 2], 'state-solmar'),
        ...pick([3], 'state-kadesh'),
        ...pick([0, 1, 15, 16], 'state-north'),
        ...pick([14, 9, 19, 4], 'state-isles'),
        ...pick([13, 18, 17, 8], 'state-sand'),
      },
      notes: 'Солмарская лига поглощает наследие Империи.',
    },
  ];

  const events: TimelineEvent[] = [
    { id: 'ev-1', date: '-1200', title: 'Основание Первой Империи', description: 'Объединение долин под властью дома Веран.', regionId: 'region-6' },
    { id: 'ev-2', date: '-1040', title: 'Великий поход на север', description: 'Первое столкновение с северными кланами.', regionId: 'region-1' },
    { id: 'ev-3', date: '-800', title: 'Открытие Штормовых островов', regionId: 'region-15' },
    { id: 'ev-4', date: '-455', title: 'Пепельная зима', description: 'Извержение и семилетний голод.' },
    { id: 'ev-5', date: '-300', title: 'Раскол Империи', description: 'Провинции провозглашают Солмарскую лигу.', regionId: 'region-7' },
    { id: 'ev-6', date: '-120', title: 'Кадешское возрождение', regionId: 'region-3' },
    { id: 'ev-7', date: '0', title: 'Договор Трёх Печатей', description: 'Начало новой эры летоисчисления.' },
    { id: 'ev-8', date: '340', title: 'Война песков', regionId: 'region-14' },
    { id: 'ev-9', date: '500', title: 'Гегемония Солмара', regionId: 'region-11' },
  ];

  // --- города
  const burgNames = [
    'Верангард', 'Солмар', 'Кадеш', 'Тихая Гавань', 'Белый Мост', 'Сольград', 'Пепелище',
    'Северный Дозор', 'Лунная Бухта', 'Красный Камень', 'Тростники', 'Высокий Шпиль',
    'Морская Стража', 'Ветреный Утёс', 'Соляной Двор', 'Дальний Брод', 'Змеиный Форт',
    'Зелёный Порог', 'Старая Гряда', 'Янтарный Порт', 'Тёмный Ключ', 'Гончарная Слобода',
  ];
  const landCells = mesh.filter((cell) => heightAt(cell.lon, cell.lat) >= 24);
  const burgs: Burg[] = [];
  const capitals = new Set(['Верангард', 'Солмар', 'Кадеш', 'Северный Дозор', 'Лунная Бухта', 'Красный Камень']);
  for (const [index, name] of burgNames.entries()) {
    const cell = landCells[Math.floor(random() * landCells.length)];
    if (!cell) continue;
    const properties = cells.find((item) => item.properties.id === `cell-${cell.index}`)?.properties;
    burgs.push({
      id: `burg-${index + 1}`,
      name,
      x: cell.lon,
      y: cell.lat,
      height: properties?.height,
      population: Math.round(4 + random() * 120),
      capital: capitals.has(name),
      cultureId: properties?.cultureId,
      religionId: properties?.religionId,
    });
  }

  const markers: MarkerPoint[] = [
    { id: 'marker-1', name: 'Руины Обсидиановой башни', x: -42, y: 12, type: 'ruins', icon: '🗼', note: 'Считается источником Пепельной зимы.' },
    { id: 'marker-2', name: 'Врата в Глубину', x: 18, y: -4, type: 'dungeon', icon: '🕳', note: 'Вход в подземный город.' },
    { id: 'marker-3', name: 'Костяной перевал', x: -8, y: 34, type: 'landmark', icon: '⛰' },
    { id: 'marker-4', name: 'Маяк Островитян', x: 62, y: -22, type: 'landmark', icon: '🔥' },
    { id: 'marker-5', name: 'Оазис Тысячи Ламп', x: 44, y: -30, type: 'settlement', icon: '🏜' },
  ];

  // --- растровая сетка высот
  const gridWidth = 100;
  const gridHeight = 56;
  const values: number[] = [];
  for (let row = 0; row < gridHeight; row++) {
    for (let column = 0; column < gridWidth; column++) {
      const lon = LON_MIN + ((column + 0.5) / gridWidth) * (LON_MAX - LON_MIN);
      const lat = LAT_MAX - ((row + 0.5) / gridHeight) * (LAT_MAX - LAT_MIN);
      values.push(heightAt(lon, lat));
    }
  }
  const heightmap: HeightGrid = {
    width: gridWidth,
    height: gridHeight,
    bbox: [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
    values,
    min: 0,
    max: 100,
  };

  const now = new Date().toISOString();
  return {
    meta: {
      name: 'Демо-мир: Веранский архипелаг',
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
      projection: 'equirectangular',
      seaLevel: 20,
      regionSource: 'cells',
      description: 'Сгенерированный пример: нерегулярная сетка ячеек, 20 регионов, 6 государств, 5 эпох.',
      era: { negative: 'до Д.', positive: 'от Д.' },
      source: 'sample',
    },
    cells: { type: 'FeatureCollection', features: cells },
    regions: { type: 'FeatureCollection', features: regions },
    layers: { heightmap, winds: { bands: [225, 45, 225, 315, 135, 315] } },
    points: { burgs, markers },
    timeline: { snapshots, events, states: STATES },
    dictionaries: {
      cultures: CULTURES,
      religions: RELIGIONS,
      languages: LANGUAGES,
      biomes: [
        'Marine', 'Hot desert', 'Savanna', 'Grassland', 'Tropical seasonal forest',
        'Temperate deciduous forest', 'Tropical rainforest', 'Temperate rainforest',
        'Taiga', 'Tundra', 'Glacier',
      ].map((name, index) => ({ id: `biome-${index}`, name, color: CATEGORICAL[index % CATEGORICAL.length] })),
    },
  };
}
