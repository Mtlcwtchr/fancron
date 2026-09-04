/**
 * Единая внутренняя модель мира (раздел 4 ТЗ).
 * Всё, что импортируется (Azgaar GeoJSON/CSV, собственный JSON), приводится к этим типам.
 * Экспорт архива — сериализация ровно этих структур в JSON внутри .zip.
 */
import type { Feature, FeatureCollection, Geometry } from 'geojson';

/** Версия схемы, пишется в meta.json. Миграции — в src/io/validate.ts. */
export const SCHEMA_VERSION = 5;

export type ProjectionId = 'equirectangular' | 'mercator' | 'naturalEarth';

/**
 * Откуда берётся геометрия регионов:
 *  - 'cells'    — регион = группа ячеек (cell.regionId), границы получаются растворением
 *                 общих рёбер; такие границы можно «рисовать» кистью;
 *  - 'geometry' — регион = собственный полигон в regions.geojson; его вершины можно двигать.
 */
export type RegionSource = 'cells' | 'geometry';

export interface EraLabels {
  /** суффикс для отрицательных дат, напр. "до О." */
  negative?: string;
  /** суффикс для неотрицательных дат, напр. "от О." */
  positive?: string;
}

/**
 * Настройки климата мира. Экватор не обязан лежать на широте 0: карта может
 * быть куском мира, и тепловой пояс уходит вверх или вниз. От этого зависят
 * температура, ветровые полосы и, через них, осадки.
 */
export interface ClimateSettings {
  /** широта, играющая роль экватора */
  equatorLat?: number;
  /** температура на экваторе, °C */
  temperatureEquator?: number;
  /** температура на полюсе, °C */
  temperaturePole?: number;
}

export interface WorldMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  description?: string;
  projection?: ProjectionId;
  era?: EraLabels;
  /** уровень моря в единицах height (Azgaar: 20 при шкале 0..100) */
  seaLevel?: number;
  regionSource?: RegionSource;
  climate?: ClimateSettings;
  /** откуда пришли данные: "azgaar", "manual", ... */
  source?: string;
}

/** Свойства ячейки/полигона тематической карты (map.geojson). */
export interface CellProperties {
  id: string;
  name?: string;
  height?: number;
  biome?: string;
  cultureId?: string;
  religionId?: string;
  languageId?: string;
  /** базовая (современная) политическая принадлежность */
  stateId?: string;
  provinceId?: string;
  /**
   * Базовый регион таймлайна, которому принадлежит ячейка (regionSource === 'cells').
   * По эпохам переопределяется через `snapshot.geo[cellId].regionId`.
   */
  regionId?: string;
  population?: number;
  /* --- результаты симуляции ландшафта --- */
  /** средняя температура, °C */
  temperature?: number;
  /** осадки, условные единицы 0..1 */
  precipitation?: number;
  /** расход воды (аккумулированный сток) */
  flux?: number;
  /** ячейка залита водой во впадине */
  lake?: boolean;
  [key: string]: unknown;
}

/** Свойства региона — единицы, которой оперирует таймлайн. */
export interface RegionProperties {
  id: string;
  name?: string;
  /** базовая принадлежность, используется когда в snapshot'е региона нет */
  stateId?: string;
  /** история переименований */
  names?: NameChange[];
  [key: string]: unknown;
}

export interface ThematicProperties {
  id: string;
  name?: string;
  color?: string;
  [key: string]: unknown;
}

export type CellCollection = FeatureCollection<Geometry, CellProperties>;
export type RegionCollection = FeatureCollection<Geometry, RegionProperties>;
export type ThematicCollection = FeatureCollection<Geometry, ThematicProperties>;
export type CellFeature = Feature<Geometry, CellProperties>;
export type RegionFeature = Feature<Geometry, RegionProperties>;

/** Переименование во времени: с даты `date` сущность зовётся `name`. */
export interface NameChange {
  date: string;
  name: string;
}

/**
 * Переход сущности в другую: с даты `date` вместо неё показывается `toId`.
 * Так описывается и смена режима («Империя» -> «Республика»), и эволюция языка
 * или культуры, без перерисовки карты.
 */
export interface Succession {
  date: string;
  toId: string;
}

/** Справочник: культура / религия / язык / биом. */
export interface DictEntry {
  id: string;
  name: string;
  color?: string;
  note?: string;
  /** история переименований */
  names?: NameChange[];
  /** во что превращается со временем */
  succeededBy?: Succession[];
}

/** Растровый слой высот: регулярная сетка значений поверх bbox [minLon,minLat,maxLon,maxLat]. */
export interface HeightGrid {
  width: number;
  height: number;
  bbox: [number, number, number, number];
  /** row-major, длина = width * height */
  values: number[];
  min?: number;
  max?: number;
}

export interface WindVector {
  lon: number;
  lat: number;
  /** направление В КОТОРОМ дует ветер, градусы, 0 = на север, по часовой */
  angle: number;
  speed?: number;
}

/**
 * Поле ветров. Либо явные векторы, либо широтные полосы (как в Azgaar:
 * 6 значений от северного полюса к южному).
 */
export interface WindField {
  bands?: number[];
  vectors?: WindVector[];
}

export interface Burg {
  id: string;
  name: string;
  /** история переименований: город может смениться имя со сменой хозяев */
  names?: NameChange[];
  /** дата основания: до неё города на карте нет */
  from?: string;
  /** дата гибели: с неё города на карте нет */
  to?: string;
  /** координаты в той же системе, что map.geojson (lon/lat) */
  x: number;
  y: number;
  height?: number;
  population?: number;
  capital?: boolean;
  port?: boolean;
  stateId?: string;
  cultureId?: string;
  religionId?: string;
  note?: string;
  [key: string]: unknown;
}

export interface MarkerPoint {
  id: string;
  name: string;
  names?: NameChange[];
  /** метка появляется с этой даты */
  from?: string;
  /** и исчезает с этой */
  to?: string;
  x: number;
  y: number;
  type?: string;
  icon?: string;
  note?: string;
  [key: string]: unknown;
}

export interface StateDef {
  id: string;
  name: string;
  color: string;
  note?: string;
  names?: NameChange[];
  succeededBy?: Succession[];
}

/**
 * Гео-правки эпохи: что изменилось в самой географии начиная с этой даты.
 * Пример: с 300 года залив затоплен, а степь стала пустыней. Базовая карта
 * не меняется, а поверх неё накапливаются оверрайды всех прошедших эпох —
 * так же, как накапливается принадлежность регионов.
 */
export interface CellOverride {
  height?: number;
  biome?: string;
  cultureId?: string;
  religionId?: string;
  languageId?: string;
  /**
   * Регион, которому ячейка принадлежит с этой эпохи. Границы регионов не статичны:
   * провинция может разрастись, распасться или появиться в определённом веке —
   * базовая карта при этом остаётся неизменной.
   */
  regionId?: string;
}

export interface Snapshot {
  id: string;
  /** произвольная строка/число — своя эра, не обязательно григорианский календарь */
  date: string;
  label?: string;
  /** regionId -> stateId на этот момент времени */
  regionState: Record<string, string>;
  /** cellId -> изменённые атрибуты географии, действуют с этой эпохи */
  geo?: Record<string, CellOverride>;
  notes?: string;
}

export interface TimelineEvent {
  id: string;
  date: string;
  title: string;
  description?: string;
  regionId?: string;
}

export interface RiverProperties {
  id: string;
  name?: string;
  type?: string;
  /** ширина в устье (Azgaar: width + widthFactor) */
  width?: number;
  discharge?: number;
  [key: string]: unknown;
}

export interface RouteProperties {
  id: string;
  name?: string;
  /** roads | trails | searoutes | ... */
  group?: string;
  [key: string]: unknown;
}

export interface ZoneProperties {
  id: string;
  name?: string;
  type?: string;
  color?: string;
  [key: string]: unknown;
}

export interface CurrentProperties {
  id: string;
  name?: string;
  /** тёплое течение несёт воду от экватора, холодное — к экватору */
  temperature?: 'warm' | 'cold';
  /** относительная скорость 0..1 */
  speed?: number;
  [key: string]: unknown;
}

export type CurrentCollection = FeatureCollection<Geometry, CurrentProperties>;
export type RiverCollection = FeatureCollection<Geometry, RiverProperties>;
export type RouteCollection = FeatureCollection<Geometry, RouteProperties>;
export type ZoneCollection = FeatureCollection<Geometry, ZoneProperties>;

export interface WorldLayers {
  heightmap?: HeightGrid;
  winds?: WindField;
  cultures?: ThematicCollection;
  religions?: ThematicCollection;
  languages?: ThematicCollection;
  rivers?: RiverCollection;
  routes?: RouteCollection;
  zones?: ZoneCollection;
  /** морские течения: результат симуляции по ветрам и Кориолису */
  currents?: CurrentCollection;
}

export interface World {
  meta: WorldMeta;
  /** map.geojson — ячейки/полигоны с тематическими атрибутами */
  cells: CellCollection;
  /** regions.geojson — политические единицы, которыми управляет таймлайн */
  regions: RegionCollection;
  layers: WorldLayers;
  points: {
    burgs: Burg[];
    markers: MarkerPoint[];
  };
  timeline: {
    snapshots: Snapshot[];
    events: TimelineEvent[];
    states: StateDef[];
  };
  dictionaries: {
    cultures: DictEntry[];
    religions: DictEntry[];
    languages: DictEntry[];
    biomes: DictEntry[];
  };
}

export function emptyFeatureCollection<T>(): FeatureCollection<Geometry, T> {
  return { type: 'FeatureCollection', features: [] };
}

export function emptyWorld(name = 'Новый мир'): World {
  const now = new Date().toISOString();
  return {
    meta: {
      name,
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
      projection: 'equirectangular',
      seaLevel: 20,
      regionSource: 'cells',
      source: 'manual',
    },
    cells: emptyFeatureCollection<CellProperties>(),
    regions: emptyFeatureCollection<RegionProperties>(),
    layers: {},
    points: { burgs: [], markers: [] },
    timeline: { snapshots: [], events: [], states: [] },
    dictionaries: { cultures: [], religions: [], languages: [], biomes: [] },
  };
}

export function isWorldEmpty(world: World): boolean {
  return (
    world.cells.features.length === 0 &&
    world.regions.features.length === 0 &&
    world.points.burgs.length === 0 &&
    world.points.markers.length === 0
  );
}
