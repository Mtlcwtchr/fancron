/**
 * Импорт мира с картинки.
 *
 * Два разных пути, потому что источники разные по природе:
 *
 *  • SVG — уже вектор. Обходим фигуры, снимаем точки контура через
 *    getPointAtLength (работает и с кривыми), переводим координаты viewBox в
 *    градусы. Каждая фигура становится регионом со своей геометрией, фигуры
 *    одного цвета — одним государством. Такие регионы правятся инструментом
 *    «Вершины».
 *
 *  • PNG/JPG — растр. Кладём поверх картинки нерегулярную сетку Voronoi и
 *    сэмплируем цвет/яркость в центре каждой ячейки. Дальше работает обычный
 *    конвейер: одинаковые ячейки растворяются в области с гладкими границами,
 *    всё правится кистями. Яркость можно прочитать как высоту (классический
 *    heightmap), а цвета — сгруппировать в государства, культуры, религии,
 *    языки, биомы или зоны.
 *
 * Точность у растрового пути принципиально ограничена: это оценка по пикселям,
 * а не разбор картинки на объекты. Зато мир получается сразу редактируемым.
 */
import type { Feature, Geometry, Position } from 'geojson';
import { biomeForConditions } from '../util/biome';
import { buildVoronoiMesh, type MeshCell } from '../util/mesh';
import { CATEGORICAL } from '../map/colors';
import { slugify, uid } from '../util/id';
import {
  SCHEMA_VERSION,
  emptyWorld,
  type CellProperties,
  type DictEntry,
  type HeightGrid,
  type RegionProperties,
  type StateDef,
  type ThematicProperties,
  type World,
  type ZoneProperties,
} from '../state/types';

/** Куда положить найденные группы. */
export type ImageTarget = 'states' | 'cultures' | 'religions' | 'languages' | 'biomes' | 'zones';

/**
 * Способ разбора растра:
 *  - heightmap — яркость как высота;
 *  - colors    — группировка по цветам заливок;
 *  - borders   — по нарисованным границам: ищем линии и заливаем замкнутые области.
 */
export type RasterMode = 'heightmap' | 'colors' | 'borders';

export interface ImageImportOptions {
  /** только для растра; SVG всегда разбирается по фигурам */
  mode: RasterMode;
  /** во что превращать найденные группы */
  target: ImageTarget;
  /** число цветовых групп для режима colors */
  clusters: number;
  /** желаемое число ячеек сетки */
  cells: number;
  /** инвертировать яркость (для heightmap) */
  invert: boolean;
  /** порог «линии» для режима borders, 0..100: темнее этого считается границей */
  inkThreshold: number;
  /** имя мира */
  name?: string;
}

export const DEFAULT_IMAGE_OPTIONS: ImageImportOptions = {
  mode: 'heightmap',
  target: 'states',
  clusters: 8,
  cells: 4000,
  invert: false,
  inkThreshold: 40,
};

export interface ImageImportResult {
  world: World;
  log: string[];
}

/** Ширина карты в градусах; высота считается по пропорциям картинки. */
const LON_SPAN = 200;

function bboxFor(width: number, height: number): [number, number, number, number] {
  const lonHalf = LON_SPAN / 2;
  const latHalf = Math.min(85, (lonHalf * height) / Math.max(1, width));
  return [-lonHalf, -latHalf, lonHalf, latHalf];
}

/* ------------------------------------------------------------------ */
/* растр                                                               */
/* ------------------------------------------------------------------ */

interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function decodeImage(file: Blob, maxSize = 900): Promise<Raster> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Не удалось получить 2d-контекст для разбора картинки');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return { width, height, data: context.getImageData(0, 0, width, height).data };
}

/** Средний цвет в окне 3x3 — сглаживает шум и полупрозрачные края. */
function sampleColor(raster: Raster, px: number, py: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.min(raster.width - 1, Math.max(0, px + dx));
      const y = Math.min(raster.height - 1, Math.max(0, py + dy));
      const index = (y * raster.width + x) * 4;
      r += raster.data[index];
      g += raster.data[index + 1];
      b += raster.data[index + 2];
      count += 1;
    }
  }
  return [r / count, g / count, b / count];
}

function luminance([r, g, b]: [number, number, number]): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function toHex([r, g, b]: [number, number, number]): string {
  const part = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * k-means по цветам с инициализацией «самый далёкий от уже выбранных».
 * Инициализация по яркости склеивала разные страны одного тона, а раскидывание
 * центров по цветовому пространству надёжно разделяет заливки карты.
 */
function clusterColors(
  colors: Array<[number, number, number]>,
  clusterCount: number,
  iterations = 10,
): { assignment: number[]; centers: Array<[number, number, number]> } {
  const count = Math.max(2, Math.min(clusterCount, 24));
  const distance = (a: [number, number, number], b: [number, number, number]): number =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  // прореженная выборка: инициализацию считаем по ней, чтобы не гонять всё
  const step = Math.max(1, Math.floor(colors.length / 3000));
  const sample: Array<[number, number, number]> = [];
  for (let i = 0; i < colors.length; i += step) sample.push(colors[i]);

  const centers: Array<[number, number, number]> = [sample[0] ?? [0, 0, 0]];
  while (centers.length < count && centers.length < sample.length) {
    let best: [number, number, number] | null = null;
    let bestDistance = -1;
    for (const color of sample) {
      let nearest = Infinity;
      for (const center of centers) nearest = Math.min(nearest, distance(color, center));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = color;
      }
    }
    if (!best || bestDistance <= 0) break;
    centers.push([...best] as [number, number, number]);
  }

  const assignment = new Array<number>(colors.length).fill(0);
  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < colors.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const value = distance(colors[i], centers[c]);
        if (value < bestDistance) {
          bestDistance = value;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved = true;
      }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < colors.length; i++) {
      const bucket = sums[assignment[i]];
      bucket[0] += colors[i][0];
      bucket[1] += colors[i][1];
      bucket[2] += colors[i][2];
      bucket[3] += 1;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] === 0) continue;
      centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (!moved && pass > 0) break;
  }
  return { assignment, centers };
}

/** «Водный» кластер: самый синий из крупных. */
function detectWaterCluster(centers: Array<[number, number, number]>, sizes: number[]): number | null {
  let best: number | null = null;
  let bestScore = 0;
  const total = sizes.reduce((sum, value) => sum + value, 0) || 1;
  for (let i = 0; i < centers.length; i++) {
    const [r, g, b] = centers[i];
    const blueness = (b - (r + g) / 2) / 255;
    const share = sizes[i] / total;
    const score = blueness * 2 + share;
    if (blueness > 0.05 && score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Результат разбора растра на группы — общий и для цветов, и для границ,
 * чтобы дальше применять его к слоям одним куском кода.
 */
interface GroupResult {
  /** индекс группы для каждой ячейки сетки; -1 — не определилась */
  assignment: number[];
  /** цвет каждой группы */
  colors: string[];
  /** какая группа считается водой */
  water: number | null;
  log: string[];
}

function groupsByColors(
  colors: Array<[number, number, number]>,
  options: ImageImportOptions,
): GroupResult {
  const log: string[] = [];
  const { assignment, centers } = clusterColors(colors, options.clusters);
  let sizes = centers.map((_center, index) => assignment.filter((value) => value === index).length);

  // на границах цветов пиксели смешиваются и дают крошечные «фантомные» группы —
  // такие раздаём ближайшему по цвету настоящему кластеру
  const minimum = Math.max(3, Math.round(colors.length * 0.004));
  const tiny = new Set(sizes.map((size, index) => (size < minimum ? index : -1)).filter((index) => index >= 0));
  if (tiny.size > 0 && tiny.size < centers.length) {
    for (let i = 0; i < assignment.length; i++) {
      if (!tiny.has(assignment[i])) continue;
      let best = assignment[i];
      let bestDistance = Infinity;
      for (let c = 0; c < centers.length; c++) {
        if (tiny.has(c)) continue;
        const center = centers[c];
        const distance =
          (colors[i][0] - center[0]) ** 2 + (colors[i][1] - center[1]) ** 2 + (colors[i][2] - center[2]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      assignment[i] = best;
    }
    sizes = centers.map((_center, index) => assignment.filter((value) => value === index).length);
    log.push(`Мелкие группы с границ раздал соседям: ${tiny.size}`);
  }

  const water = detectWaterCluster(centers, sizes);
  log.push(`Цветовых групп: ${centers.length}${water !== null ? `, водной признана группа ${water + 1}` : ''}`);
  return { assignment, colors: centers.map((center) => toHex(center)), water, log };
}

/* ------------------------------------------------------------------ */
/* разбор по нарисованным границам                                     */
/* ------------------------------------------------------------------ */

/**
 * Маска «линий»: пиксель считается границей, если он тёмный или на резком
 * перепаде цвета. Первое ловит нарисованные тушью контуры, второе — стыки
 * заливок без обводки.
 */
function inkMask(raster: Raster, threshold: number): Uint8Array {
  const { width, height, data } = raster;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }

  const ink = new Uint8Array(width * height);
  const darkLimit = Math.min(0.95, Math.max(0.05, threshold / 100));
  const edgeLimit = 0.32;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (gray[index] < darkLimit) {
        ink[index] = 1;
        continue;
      }
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      // Собель по яркости
      const gx =
        gray[index - width - 1] + 2 * gray[index - 1] + gray[index + width - 1] -
        gray[index - width + 1] - 2 * gray[index + 1] - gray[index + width + 1];
      const gy =
        gray[index - width - 1] + 2 * gray[index - width] + gray[index - width + 1] -
        gray[index + width - 1] - 2 * gray[index + width] - gray[index + width + 1];
      if (Math.hypot(gx, gy) > edgeLimit * 4) ink[index] = 1;
    }
  }
  return ink;
}

interface Component {
  label: number;
  size: number;
  color: [number, number, number];
  touchesBorder: boolean;
}

/** Заливка замкнутых областей между линиями: каждая область — своя группа. */
function floodComponents(raster: Raster, ink: Uint8Array): { labels: Int32Array; components: Component[] } {
  const { width, height, data } = raster;
  // «касается края» считаем с допуском: у карты может быть нарисованная рамка,
  // и тогда внешняя область не доходит до самого пикселя границы
  const margin = Math.max(2, Math.round(Math.min(width, height) * 0.01));
  const labels = new Int32Array(width * height); // 0 = линия либо ещё не размечено
  const components: Component[] = [];
  const stack: number[] = [];
  let nextLabel = 0;

  for (let seed = 0; seed < labels.length; seed++) {
    if (ink[seed] === 1 || labels[seed] !== 0) continue;
    nextLabel += 1;
    let size = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let touchesBorder = false;

    stack.push(seed);
    labels[seed] = nextLabel;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      size += 1;
      sumR += data[index * 4];
      sumG += data[index * 4 + 1];
      sumB += data[index * 4 + 2];
      if (x < margin || y < margin || x >= width - margin || y >= height - margin) touchesBorder = true;

      if (x > 0) {
        const left = index - 1;
        if (ink[left] === 0 && labels[left] === 0) {
          labels[left] = nextLabel;
          stack.push(left);
        }
      }
      if (x < width - 1) {
        const right = index + 1;
        if (ink[right] === 0 && labels[right] === 0) {
          labels[right] = nextLabel;
          stack.push(right);
        }
      }
      if (y > 0) {
        const up = index - width;
        if (ink[up] === 0 && labels[up] === 0) {
          labels[up] = nextLabel;
          stack.push(up);
        }
      }
      if (y < height - 1) {
        const down = index + width;
        if (ink[down] === 0 && labels[down] === 0) {
          labels[down] = nextLabel;
          stack.push(down);
        }
      }
    }

    components.push({
      label: nextLabel,
      size,
      color: [sumR / size, sumG / size, sumB / size],
      touchesBorder,
    });
  }

  return { labels, components };
}

/** Ближайшая размеченная точка — для ячеек, чей центр попал прямо на линию. */
function nearestLabel(labels: Int32Array, width: number, height: number, px: number, py: number): number {
  const direct = labels[py * width + px];
  if (direct !== 0) return direct;
  for (let radius = 1; radius <= 8; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const label = labels[y * width + x];
        if (label !== 0) return label;
      }
    }
  }
  return 0;
}

function groupsByBorders(
  raster: Raster,
  meshPixels: Array<[number, number]>,
  options: ImageImportOptions,
  colorSource?: Raster,
): GroupResult {
  const log: string[] = [];
  const ink = inkMask(raster, options.inkThreshold);
  const inkShare = ink.reduce((sum, value) => sum + value, 0) / ink.length;
  const { labels, components } = floodComponents(colorSource ?? raster, ink);

  // мусорные крапинки выкидываем: они не области, а шум сканирования
  const minSize = Math.max(24, Math.round(raster.width * raster.height * 0.0004));
  const kept = components.filter((component) => component.size >= minSize).sort((a, b) => b.size - a.size);
  log.push(
    `Линии занимают ${(inkShare * 100).toFixed(1)}% пикселей; замкнутых областей ${components.length}, ` +
      `после отсева мелких — ${kept.length}`,
  );
  if (kept.length === 0) {
    throw new Error(
      'По границам ничего не нашлось: линии либо не распознались, либо залили всю картинку. ' +
        'Попробуйте другой порог линий или режим «цветовые группы».',
    );
  }

  const groupOf = new Map<number, number>();
  kept.forEach((component, index) => groupOf.set(component.label, index));

  const assignment = meshPixels.map(([px, py]) => {
    const label = nearestLabel(labels, raster.width, raster.height, px, py);
    return groupOf.get(label) ?? -1;
  });

  // внешняя область (фон/море) обычно самая большая и касается рамки
  let water: number | null = null;
  const outside = kept.findIndex((component) => component.touchesBorder);
  if (outside >= 0) {
    water = outside;
    log.push(`Внешняя область (${kept[water].size} px) принята за море`);
  } else {
    // рамка замкнула всё: тогда морем считаем самую синюю крупную область
    const sizes = kept.map((component) => component.size);
    const blue = detectWaterCluster(
      kept.map((component) => component.color),
      sizes,
    );
    if (blue !== null) {
      water = blue;
      log.push(`Внешней области нет; морем принята самая синяя область (${sizes[blue]} px)`);
    }
  }

  // если одна область заняла почти всё — линии не замкнуты и заливка «протекла»
  const largest = kept[0];
  if (largest && largest.size > raster.width * raster.height * 0.7 && kept.length < 3) {
    log.push(
      'Похоже, линии не замкнуты: заливка растеклась по всей карте. ' +
        'Поднимите порог линий или используйте разбор по заливкам.',
    );
  }

  return { assignment, colors: kept.map((component) => toHex(component.color)), water, log };
}

/**
 * Разложить найденные группы по слоям мира: государства с регионами либо записи
 * справочника. Общий код для растра и для SVG, разобранного по границам.
 */
/**
 * Линейная графика без заливок даёт почти белые «цвета» областей — на карте они
 * неразличимы. Такие подменяем палитрой, цветные заливки оставляем как есть.
 */
function displayColor(hex: string, index: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return CATEGORICAL[index % CATEGORICAL.length];
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const pale = max - min < 34 && (max + min) / 2 > 205;
  return pale ? CATEGORICAL[index % CATEGORICAL.length] : hex;
}

function applyGroupsToWorld(
  world: World,
  cellFeatures: Array<Feature<Geometry, CellProperties>>,
  mesh: MeshCell[],
  groups: GroupResult,
  target: ImageTarget,
): string[] {
  const log: string[] = [];
  const sizes = groups.colors.map((_color, index) => groups.assignment.filter((value) => value === index).length);

  // высоты ставим грубо: вода ниже уровня моря, остальное — суша
  for (const [index, feature] of cellFeatures.entries()) {
    const group = groups.assignment[index];
    const isWater = group === groups.water || group === -1;
    feature.properties.height = isWater ? 8 : 42;
    feature.properties.biome = isWater ? 'Marine' : biomeForConditions(42, mesh[index].lat, 20, 100);
  }

  const groupName = (index: number): string => `Область ${index + 1}`;

  if (target === 'states') {
    const states: StateDef[] = [];
    const regions: Array<Feature<Geometry, RegionProperties>> = [];
    for (let group = 0; group < groups.colors.length; group++) {
      if (group === groups.water || sizes[group] === 0) continue;
      const stateId = `state-${group + 1}`;
      states.push({ id: stateId, name: groupName(group), color: displayColor(groups.colors[group], group) });
      regions.push({
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: [] },
        properties: { id: `region-${group + 1}`, name: groupName(group), stateId },
      });
    }
    for (const [index, feature] of cellFeatures.entries()) {
      const group = groups.assignment[index];
      if (group === groups.water || group === -1 || sizes[group] === 0) continue;
      feature.properties.regionId = `region-${group + 1}`;
      feature.properties.stateId = `state-${group + 1}`;
    }
    world.timeline.states = states;
    world.regions = { type: 'FeatureCollection', features: regions };
    world.timeline.snapshots = [
      {
        id: 'snap-present',
        date: '0',
        label: 'Импорт с картинки',
        regionState: Object.fromEntries(regions.map((region) => [region.properties.id, region.properties.stateId!])),
      },
    ];
    log.push(`Государств создано: ${states.length}`);
    return log;
  }

  const attribute =
    target === 'cultures'
      ? 'cultureId'
      : target === 'religions'
        ? 'religionId'
        : target === 'languages'
          ? 'languageId'
          : 'biome';
  const entries: DictEntry[] = [];
  for (let group = 0; group < groups.colors.length; group++) {
    if (group === groups.water || sizes[group] === 0) continue;
    const value = attribute === 'biome' ? groupName(group) : `${target.slice(0, -1)}-${group + 1}`;
    entries.push({
      id: attribute === 'biome' ? `biome-${group + 1}` : value,
      name: groupName(group),
      color: displayColor(groups.colors[group], group),
    });
    for (const [index, feature] of cellFeatures.entries()) {
      if (groups.assignment[index] !== group) continue;
      (feature.properties as Record<string, unknown>)[attribute] = value;
    }
  }
  if (attribute === 'biome') world.dictionaries.biomes = entries;
  else if (target === 'cultures') world.dictionaries.cultures = entries;
  else if (target === 'religions') world.dictionaries.religions = entries;
  else if (target === 'languages') world.dictionaries.languages = entries;
  log.push(`Записей в справочнике: ${entries.length}`);
  return log;
}

/* ------------------------------------------------------------------ */
/* растровый импорт                                                    */
/* ------------------------------------------------------------------ */

export async function importRasterImage(
  file: File,
  requested: ImageImportOptions,
): Promise<ImageImportResult> {
  const log: string[] = [];
  // зоны — понятие векторное: с растра области честнее положить в культуры
  const options: ImageImportOptions =
    requested.target === 'zones' && requested.mode !== 'heightmap'
      ? { ...requested, target: 'cultures' }
      : requested;
  if (options !== requested) {
    log.push('С растра зоны не собрать — области положены в культуры, их можно перенести кистью');
  }

  const raster = await decodeImage(file);
  const bbox = bboxFor(raster.width, raster.height);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  log.push(`Картинка ${raster.width}x${raster.height}, рабочая рамка ${LON_SPAN}° по долготе`);

  const mesh = buildVoronoiMesh({ bbox, count: options.cells, jitter: 0.45 });
  log.push(`Сетка ячеек: ${mesh.length}`);

  const toPixel = (lon: number, lat: number): [number, number] => [
    Math.min(raster.width - 1, Math.max(0, Math.round(((lon - minLon) / (maxLon - minLon)) * (raster.width - 1)))),
    Math.min(raster.height - 1, Math.max(0, Math.round(((maxLat - lat) / (maxLat - minLat)) * (raster.height - 1)))),
  ];
  const meshPixels = mesh.map((cell) => toPixel(cell.lon, cell.lat));

  const world = emptyWorld(options.name || file.name.replace(/\.[a-z0-9]+$/i, ''));
  world.meta.source = 'image';
  world.meta.seaLevel = 20;
  world.meta.regionSource = 'cells';
  world.meta.description = `Импорт из ${file.name}`;

  const cellFeatures: Array<Feature<Geometry, CellProperties>> = mesh.map((cell, index) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [cell.ring] },
    properties: { id: `cell-${index}`, height: 0 },
  }));

  if (options.mode === 'heightmap') {
    // яркость -> высота 0..100, уровень моря 20
    for (const [index, feature] of cellFeatures.entries()) {
      const value = luminance(sampleColor(raster, meshPixels[index][0], meshPixels[index][1]));
      const normalized = options.invert ? 1 - value : value;
      const height = Math.round(normalized * 100);
      feature.properties.height = height;
      feature.properties.biome = biomeForConditions(height, mesh[index].lat, 20, 100);
    }

    // плюс растровая сетка высот, чтобы слой рельефа выглядел как в FMG
    const gridWidth = Math.min(220, raster.width);
    const gridHeight = Math.max(2, Math.round((gridWidth * raster.height) / raster.width));
    const values: number[] = [];
    for (let row = 0; row < gridHeight; row++) {
      for (let column = 0; column < gridWidth; column++) {
        const px = Math.round(((column + 0.5) / gridWidth) * (raster.width - 1));
        const py = Math.round(((row + 0.5) / gridHeight) * (raster.height - 1));
        const value = luminance(sampleColor(raster, px, py));
        values.push(Math.round((options.invert ? 1 - value : value) * 100));
      }
    }
    world.layers.heightmap = { width: gridWidth, height: gridHeight, bbox, values, min: 0, max: 100 };
    const land = cellFeatures.filter((feature) => (feature.properties.height ?? 0) >= 20).length;
    log.push(`Рельеф прочитан из яркости: суши ${land} из ${cellFeatures.length} ячеек`);
  } else {
    const groups =
      options.mode === 'borders'
        ? groupsByBorders(raster, meshPixels, options)
        : groupsByColors(
            meshPixels.map(([px, py]) => sampleColor(raster, px, py)),
            options,
          );
    log.push(...groups.log);
    log.push(...applyGroupsToWorld(world, cellFeatures, mesh, groups, options.target));
  }

  world.cells = { type: 'FeatureCollection', features: cellFeatures };
  world.layers.winds = { bands: [225, 45, 225, 315, 135, 315] };
  world.meta.schemaVersion = SCHEMA_VERSION;
  return { world, log };
}

/* ------------------------------------------------------------------ */
/* SVG: разбор по нарисованным границам                                */
/* ------------------------------------------------------------------ */

/**
 * Отрисовать SVG в растр через штатный рендерер браузера — так бесплатно
 * поддерживаются кривые, трансформации, группы и CSS внутри документа.
 * `lineArt` превращает документ в чистую линейную графику: все заливки
 * снимаются, обводки становятся чёрными и достаточно толстыми, подписи
 * убираются. Именно эта версия годится для поиска замкнутых областей.
 */
async function rasterizeSvg(svgText: string, maxSize: number, lineArt: boolean): Promise<Raster> {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = parsed.documentElement as unknown as SVGSVGElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('Это не SVG-документ');

  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value));
  const vbWidth = hasViewBox ? viewBox[2] : parseFloat(root.getAttribute('width') ?? '1000') || 1000;
  const vbHeight = hasViewBox ? viewBox[3] : parseFloat(root.getAttribute('height') ?? '1000') || 1000;
  if (!hasViewBox) root.setAttribute('viewBox', `0 0 ${vbWidth} ${vbHeight}`);

  const scale = Math.min(1.6, maxSize / Math.max(vbWidth, vbHeight));
  const width = Math.max(2, Math.round(vbWidth * scale));
  const height = Math.max(2, Math.round(vbHeight * scale));
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));

  if (lineArt) {
    // через !important, потому что заливки могут приходить из CSS внутри документа
    const style = parsed.createElementNS('http://www.w3.org/2000/svg', 'style');
    const strokeWidth = Math.max(1.6, 2.4 / scale);
    style.textContent =
      `*{fill:none !important;stroke:#000 !important;stroke-opacity:1 !important;` +
      `stroke-width:${strokeWidth} !important;filter:none !important;opacity:1 !important;` +
      `stroke-dasharray:none !important}` +
      `text,image,use{display:none !important}`;
    root.appendChild(style);
  }

  const serialized = new XMLSerializer().serializeToString(parsed);
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Браузер не смог отрисовать этот SVG'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Не удалось получить 2d-контекст');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * SVG по границам: линии растеризуются, замкнутые области заливаются, цвет каждой
 * области берётся из обычной отрисовки того же документа. Работает и когда границы —
 * это обводки без заливки, и когда карта собрана из соседних залитых фигур.
 */
async function importSvgByBorders(
  file: File,
  svgText: string,
  options: ImageImportOptions,
): Promise<ImageImportResult> {
  const log: string[] = [];
  const lineArt = await rasterizeSvg(svgText, 1200, true);
  const original = await rasterizeSvg(svgText, 1200, false);
  log.push(`SVG отрисован в ${lineArt.width}x${lineArt.height} для поиска границ`);

  const bbox = bboxFor(lineArt.width, lineArt.height);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const mesh = buildVoronoiMesh({ bbox, count: options.cells, jitter: 0.45 });
  log.push(`Сетка ячеек: ${mesh.length}`);

  const meshPixels = mesh.map((cell) => [
    Math.min(lineArt.width - 1, Math.max(0, Math.round(((cell.lon - minLon) / (maxLon - minLon)) * (lineArt.width - 1)))),
    Math.min(lineArt.height - 1, Math.max(0, Math.round(((maxLat - cell.lat) / (maxLat - minLat)) * (lineArt.height - 1)))),
  ] as [number, number]);

  // порог поднимаем: линии мы сами сделали чёрными, а сглаженные края должны попасть в маску
  const groups = groupsByBorders(
    lineArt,
    meshPixels,
    { ...options, inkThreshold: Math.max(options.inkThreshold, 55) },
    original,
  );
  log.push(...groups.log);

  const world = emptyWorld(options.name || file.name.replace(/\.svg$/i, ''));
  world.meta.source = 'svg-borders';
  world.meta.seaLevel = 20;
  world.meta.regionSource = 'cells';
  world.meta.description = `Импорт из ${file.name} по нарисованным границам`;
  world.layers.winds = { bands: [225, 45, 225, 315, 135, 315] };

  const cellFeatures: Array<Feature<Geometry, CellProperties>> = mesh.map((cell, index) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [cell.ring] },
    properties: { id: `cell-${index}`, height: 0 },
  }));

  log.push(...applyGroupsToWorld(world, cellFeatures, mesh, groups, options.target === 'zones' ? 'states' : options.target));
  world.cells = { type: 'FeatureCollection', features: cellFeatures };
  world.meta.schemaVersion = SCHEMA_VERSION;
  return { world, log };
}

/* ------------------------------------------------------------------ */
/* SVG: разбор по фигурам                                              */
/* ------------------------------------------------------------------ */

interface SvgShape {
  name: string;
  color: string;
  ring: Position[];
  area: number;
}

function shapeName(element: Element, index: number): string {
  const title = element.querySelector('title')?.textContent?.trim();
  const label =
    element.getAttribute('inkscape:label') ??
    element.getAttribute('data-name') ??
    element.getAttribute('aria-label') ??
    element.getAttribute('id');
  return title || label || `Фигура ${index + 1}`;
}

function ringArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0, length = ring.length; i < length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function rgbToHex(value: string): string | null {
  const match = value.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/i);
  if (match) {
    if (match[4] !== undefined && parseFloat(match[4]) === 0) return null;
    return toHex([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase();
  }
  return null;
}

export async function importSvgMap(file: File, options: ImageImportOptions): Promise<ImageImportResult> {
  const log: string[] = [];
  const text = await file.text();

  // границы нарисованы обводками (или просто нужны области между линиями) —
  // это принципиально другой разбор, чем обход залитых фигур
  if (options.mode === 'borders') return importSvgByBorders(file, text, options);

  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const source = parsed.documentElement;
  if (!source || source.nodeName.toLowerCase() !== 'svg') throw new Error('Это не SVG-документ');

  const viewBox = (source.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value));
  const vbWidth = hasViewBox ? viewBox[2] : parseFloat(source.getAttribute('width') ?? '1000') || 1000;
  const vbHeight = hasViewBox ? viewBox[3] : parseFloat(source.getAttribute('height') ?? '1000') || 1000;
  const vbMinX = hasViewBox ? viewBox[0] : 0;
  const vbMinY = hasViewBox ? viewBox[1] : 0;

  // рендерим копию скрыто: без вставки в документ getPointAtLength/getCTM не работают
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden';
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(vbWidth));
  clone.setAttribute('height', String(vbHeight));
  clone.setAttribute('viewBox', `${vbMinX} ${vbMinY} ${vbWidth} ${vbHeight}`);
  holder.appendChild(clone);
  document.body.appendChild(holder);

  const bbox = bboxFor(vbWidth, vbHeight);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const toLonLat = (x: number, y: number): Position => [
    minLon + (x / vbWidth) * (maxLon - minLon),
    maxLat - (y / vbHeight) * (maxLat - minLat),
  ];

  const shapes: SvgShape[] = [];
  try {
    const elements = Array.from(
      clone.querySelectorAll<SVGGraphicsElement>('path, polygon, polyline, rect, circle, ellipse'),
    );
    for (const [index, element] of elements.entries()) {
      const geometry = element as unknown as SVGGeometryElement;
      if (typeof geometry.getTotalLength !== 'function') continue;
      let length = 0;
      try {
        length = geometry.getTotalLength();
      } catch {
        continue;
      }
      if (!Number.isFinite(length) || length < 4) continue;

      const fill = rgbToHex(getComputedStyle(element).fill || '');
      if (!fill) continue; // без заливки это обводка/подпись, не область

      const samples = Math.min(500, Math.max(16, Math.round(length / 3)));
      const matrix = element.getCTM();
      const ring: Position[] = [];
      for (let i = 0; i <= samples; i++) {
        const point = geometry.getPointAtLength((i / samples) * length);
        const x = matrix ? matrix.a * point.x + matrix.c * point.y + matrix.e : point.x;
        const y = matrix ? matrix.b * point.x + matrix.d * point.y + matrix.f : point.y;
        ring.push(toLonLat(x, y));
      }
      if (ring.length < 4) continue;
      ring.push([...ring[0]] as Position);
      shapes.push({ name: shapeName(element, index), color: fill, ring, area: ringArea(ring) });
    }
  } finally {
    holder.remove();
  }

  if (shapes.length === 0) throw new Error('В SVG не нашлось залитых фигур — импортировать нечего');

  // фон (океан/рамка) занимает почти весь холст — как регион он бесполезен
  const canvasArea = (maxLon - minLon) * (maxLat - minLat);
  const background = shapes.filter((shape) => shape.area > canvasArea * 0.85);
  const useful = shapes.filter((shape) => shape.area <= canvasArea * 0.85);
  if (background.length > 0) log.push(`Пропущено фоновых фигур: ${background.length}`);
  log.push(`Фигур принято: ${useful.length}`);

  const world = emptyWorld(options.name || file.name.replace(/\.svg$/i, ''));
  world.meta.source = 'svg';
  world.meta.seaLevel = 0;
  world.meta.regionSource = 'geometry';
  world.meta.description = `Импорт из ${file.name}`;
  world.layers.winds = { bands: [225, 45, 225, 315, 135, 315] };

  if (options.target === 'zones') {
    world.layers.zones = {
      type: 'FeatureCollection',
      features: useful.map((shape, index) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [shape.ring] },
        properties: { id: `zone-${index + 1}`, name: shape.name, color: shape.color },
      })),
    };
    log.push(`Зон создано: ${useful.length}`);
    return { world, log };
  }

  if (options.target === 'cultures' || options.target === 'religions' || options.target === 'languages') {
    const collection = {
      type: 'FeatureCollection' as const,
      features: useful.map((shape, index) => ({
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [shape.ring] },
        properties: { id: `${options.target}-${index + 1}`, name: shape.name, color: shape.color },
      })),
    };
    world.layers[options.target] = collection;
    const entries: DictEntry[] = collection.features.map((feature) => ({
      id: feature.properties.id,
      name: feature.properties.name,
      color: feature.properties.color,
    }));
    if (options.target === 'cultures') world.dictionaries.cultures = entries;
    else if (options.target === 'religions') world.dictionaries.religions = entries;
    else world.dictionaries.languages = entries;
    log.push(`Ареалов создано: ${collection.features.length}`);
    return { world, log };
  }

  // по умолчанию: фигура = регион, одинаковый цвет = одно государство
  const statesByColor = new Map<string, StateDef>();
  const regions: Array<Feature<Geometry, RegionProperties>> = [];
  for (const [index, shape] of useful.entries()) {
    let state = statesByColor.get(shape.color);
    if (!state) {
      state = {
        id: `state-${slugify(shape.color, String(statesByColor.size + 1))}`,
        name: shape.name,
        color: shape.color,
      };
      statesByColor.set(shape.color, state);
    }
    regions.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [shape.ring] },
      properties: { id: `region-${index + 1}`, name: shape.name, stateId: state.id },
    });
  }

  world.regions = { type: 'FeatureCollection', features: regions };
  world.timeline.states = [...statesByColor.values()].map((state, index) => ({
    ...state,
    color: state.color || CATEGORICAL[index % CATEGORICAL.length],
  }));
  world.timeline.snapshots = [
    {
      id: uid('snap'),
      date: '0',
      label: 'Импорт из SVG',
      regionState: Object.fromEntries(
        regions.map((region) => [region.properties.id, region.properties.stateId ?? '']),
      ),
    },
  ];
  log.push(`Регионов: ${regions.length}, государств: ${world.timeline.states.length}`);
  return { world, log };
}

export function isImageFile(file: File): boolean {
  return /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name) || file.type.startsWith('image/');
}

export function isSvgFile(file: File): boolean {
  return /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
}
