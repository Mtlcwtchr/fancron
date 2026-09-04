/**
 * Симуляция ландшафта: тектоника -> климат -> гидрология -> биомы.
 *
 * Работает по существующей сетке ячеек и её соседству, поэтому одинаково
 * применима к сгенерированной пустой карте, к импорту из Azgaar и к миру,
 * собранному с картинки. Каждый этап можно включить отдельно: например,
 * оставить готовый рельеф и посчитать по нему только реки и озёра.
 *
 * Модель намеренно простая, но физически осмысленная:
 *  • плиты и их сближение дают горные хребты, расхождение — рифты;
 *  • влага переносится ветром, теряется над сушей и выпадает при подъёме
 *    (орографический дождь), за хребтами остаётся дождевая тень;
 *  • впадины заливаются алгоритмом priority-flood — так получаются озёра
 *    с естественным стоком, а не «дыры» без выхода;
 *  • сток аккумулируется вниз по склону, и там, где расход воды переходит
 *    порог, появляется река; ширина — от расхода.
 */
import type { Feature, Geometry, Position } from 'geojson';
import { seaLevelOf } from '../map/layers';
import { topologyOf } from '../state/topology';
import type { CurrentProperties, RiverProperties, World } from '../state/types';
import { mulberry32 } from '../util/random';
import { windAngleAt, windVectorAt } from '../util/wind';

export interface LandformOptions {
  /** генерировать рельеф с нуля (иначе берётся существующий) */
  terrain: boolean;
  /**
   * Сохранять существующую линию берега: море остаётся морем, суша сушей,
   * а заново лепится только рельеф внутри материков — хребты, склоны, плато.
   */
  respectCoastline: boolean;
  /**
   * Отступ океана от краёв карты, доля половины размера (0..0.45).
   * Без него материки упираются в рамку и выглядят обрезанными.
   */
  edgeFalloff: number;
  /** число тектонических плит */
  plates: number;
  /** целевая доля моря, 0..0.95 */
  seaShare: number;
  /** сила фрактального шума, 0..1 */
  roughness: number;
  /** проходов речной эрозии */
  erosion: number;
  /** считать морские течения (Экман + Кориолис) и их влияние на климат */
  currents: boolean;
  /** считать температуру и осадки */
  climate: boolean;
  /** заливать впадины (озёра) и считать реки */
  hydrology: boolean;
  /** порог расхода воды для реки, 0..1 от максимума */
  riverThreshold: number;
  /** пересобрать биомы по климату */
  biomes: boolean;
  seed?: number;
}

export const DEFAULT_LANDFORM_OPTIONS: LandformOptions = {
  terrain: false,
  respectCoastline: true,
  edgeFalloff: 0.28,
  plates: 7,
  seaShare: 0.62,
  roughness: 0.5,
  erosion: 2,
  currents: true,
  climate: true,
  hydrology: true,
  riverThreshold: 0.06,
  biomes: true,
};

/* ------------------------------------------------------------------ */
/* вспомогательные структуры                                           */
/* ------------------------------------------------------------------ */

/** Насколько глубокой должна быть впадина, чтобы считаться озером (в единицах высоты). */
const LAKE_DEPTH = 1.5;

/** Минимальная двоичная куча: нужна для заливки впадин. */
class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let index = this.keys.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent] <= this.keys[index]) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  pop(): { key: number; value: number } | null {
    if (this.keys.length === 0) return null;
    const result = { key: this.keys[0], value: this.values[0] };
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(smallest, index);
        index = smallest;
      }
    }
    return result;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
}

interface Grid {
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  neighbors: Int32Array[];
  height: Float64Array;
  ids: string[];
  /** границы карты [minLon, minLat, maxLon, maxLat] — нужны для отступа от рамки */
  bbox: [number, number, number, number];
}

function buildGrid(world: World): Grid {
  const topology = topologyOf(world);
  const cells = topology.cells;
  const count = cells.length;
  const index = new Map<string, number>();
  cells.forEach((cell, i) => index.set(cell.properties.id, i));

  const lon = new Float64Array(count);
  const lat = new Float64Array(count);
  const height = new Float64Array(count);
  const ids: string[] = new Array(count);
  const neighbors: Int32Array[] = new Array(count);

  cells.forEach((cell, i) => {
    const id = cell.properties.id;
    ids[i] = id;
    const point = topology.pointById.get(id);
    lon[i] = point?.lon ?? 0;
    lat[i] = point?.lat ?? 0;
    height[i] = Number(cell.properties.height ?? 0);
    const list = topology.neighbors.get(id) ?? [];
    const mapped: number[] = [];
    for (const neighborId of list) {
      const j = index.get(neighborId);
      if (j !== undefined) mapped.push(j);
    }
    neighbors[i] = Int32Array.from(mapped);
  });

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < count; i++) {
    minLon = Math.min(minLon, lon[i]);
    maxLon = Math.max(maxLon, lon[i]);
    minLat = Math.min(minLat, lat[i]);
    maxLat = Math.max(maxLat, lat[i]);
  }

  return { count, lon, lat, neighbors, height, ids, bbox: [minLon, minLat, maxLon, maxLat] };
}

/**
 * Насколько ячейка «внутри» карты: 1 в центре, 0 у самой рамки.
 * Материк, упирающийся в край, выглядит обрезанным, поэтому у краёв
 * рельеф плавно уводится под воду.
 */
function insideness(grid: Grid, index: number, margin: number): number {
  const [minLon, minLat, maxLon, maxLat] = grid.bbox;
  const halfLon = (maxLon - minLon) / 2 || 1;
  const halfLat = (maxLat - minLat) / 2 || 1;
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;

  const dx = Math.abs(grid.lon[index] - centerLon) / halfLon; // 0..1
  const dy = Math.abs(grid.lat[index] - centerLat) / halfLat;
  const edge = Math.max(dx, dy);
  const start = 1 - Math.min(0.45, Math.max(0, margin));
  if (edge <= start) return 1;
  const t = (edge - start) / Math.max(1e-6, 1 - start);
  // плавная S-кривая, чтобы берег не обрывался ступенькой
  const smooth = 1 - t * t * (3 - 2 * t);
  return Math.max(0, Math.min(1, smooth));
}

/* ------------------------------------------------------------------ */
/* 1. тектоника и рельеф                                               */
/* ------------------------------------------------------------------ */

/** Многомасштабный шум прямо на сетке: случайные всплески + повторное сглаживание. */
function meshNoise(grid: Grid, random: () => number, octaves = 4): Float64Array {
  const total = new Float64Array(grid.count);
  let amplitude = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const step = Math.max(1, Math.round(grid.count / (12 * 2 ** octave)));
    const layer = new Float64Array(grid.count);
    for (let i = 0; i < grid.count; i += step) layer[i] = random() * 2 - 1;
    // сглаживание раздувает всплески до нужного масштаба
    const passes = Math.max(1, 10 - octave * 2);
    for (let pass = 0; pass < passes; pass++) {
      const next = new Float64Array(grid.count);
      for (let i = 0; i < grid.count; i++) {
        let sum = layer[i];
        let n = 1;
        for (const j of grid.neighbors[i]) {
          sum += layer[j];
          n += 1;
        }
        next[i] = sum / n;
      }
      layer.set(next);
    }
    let max = 1e-6;
    for (let i = 0; i < grid.count; i++) max = Math.max(max, Math.abs(layer[i]));
    for (let i = 0; i < grid.count; i++) total[i] += (layer[i] / max) * amplitude;
    amplitude *= 0.55;
  }
  return total;
}

/** Расстояние по графу от набора стартовых ячеек (в шагах). */
function graphDistance(grid: Grid, sources: number[]): Int32Array {
  const distance = new Int32Array(grid.count).fill(-1);
  const queue: number[] = [];
  for (const source of sources) {
    distance[source] = 0;
    queue.push(source);
  }
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const next of grid.neighbors[current]) {
      if (distance[next] !== -1) continue;
      distance[next] = distance[current] + 1;
      queue.push(next);
    }
  }
  return distance;
}

/** Тектонические плиты: индекс плиты для каждой ячейки плюс их дрейф и характер. */
interface Plates {
  plate: Int32Array;
  driftX: Float64Array;
  driftY: Float64Array;
  continental: Uint8Array;
  count: number;
}

function buildPlates(grid: Grid, plateCount: number, random: () => number): Plates {
  const seeds: number[] = [];
  const used = new Set<number>();
  // центры плит держим подальше от рамки, иначе половина плиты уходит за карту
  let guard = 0;
  while (seeds.length < plateCount && guard++ < plateCount * 200) {
    const candidate = Math.floor(random() * grid.count);
    if (used.has(candidate)) continue;
    if (insideness(grid, candidate, 0.15) < 0.6) continue;
    used.add(candidate);
    seeds.push(candidate);
  }
  while (seeds.length < plateCount) seeds.push(Math.floor(random() * grid.count));

  const plate = new Int32Array(grid.count).fill(-1);
  const queue: number[] = [];
  seeds.forEach((seed, index) => {
    plate[seed] = index;
    queue.push(seed);
  });
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const next of grid.neighbors[current]) {
      if (plate[next] !== -1) continue;
      plate[next] = plate[current];
      queue.push(next);
    }
  }

  const driftX = new Float64Array(plateCount);
  const driftY = new Float64Array(plateCount);
  const continental = new Uint8Array(plateCount);
  for (let p = 0; p < plateCount; p++) {
    const angle = random() * Math.PI * 2;
    driftX[p] = Math.cos(angle);
    driftY[p] = Math.sin(angle);
    continental[p] = random() < 0.45 ? 1 : 0;
  }
  return { plate, driftX, driftY, continental, count: plateCount };
}

/** Границы плит: сходящиеся (горы) и расходящиеся (рифты). */
function plateBoundaries(grid: Grid, plates: Plates): { convergent: number[]; divergent: number[] } {
  const convergent: number[] = [];
  const divergent: number[] = [];
  for (let i = 0; i < grid.count; i++) {
    for (const j of grid.neighbors[i]) {
      if (plates.plate[j] === plates.plate[i] || j < i) continue;
      const dx = grid.lon[j] - grid.lon[i];
      const dy = grid.lat[j] - grid.lat[i];
      const length = Math.hypot(dx, dy) || 1;
      const relativeX = plates.driftX[plates.plate[i]] - plates.driftX[plates.plate[j]];
      const relativeY = plates.driftY[plates.plate[i]] - plates.driftY[plates.plate[j]];
      const closing = (relativeX * dx + relativeY * dy) / length;
      if (closing > 0.15) convergent.push(i, j);
      else if (closing < -0.15) divergent.push(i, j);
    }
  }
  return { convergent, divergent };
}

/**
 * Синтетические хребты: случайные «прогулки» по суше в выбранном направлении.
 * Нужны, когда границы плит не попали на материк — иначе остров окажется
 * идеально плоским, что для карты бессмысленно.
 */
function synthesizeRidges(
  grid: Grid,
  allowed: Uint8Array,
  random: () => number,
  ridges: number,
  length: number,
): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < grid.count; i++) if (allowed[i]) candidates.push(i);
  if (candidates.length === 0) return [];

  const result: number[] = [];
  for (let r = 0; r < ridges; r++) {
    let current = candidates[Math.floor(random() * candidates.length)];
    let angle = random() * Math.PI * 2;
    for (let step = 0; step < length; step++) {
      result.push(current);
      angle += (random() - 0.5) * 0.7; // хребет виляет, а не идёт по линейке
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      let best = -1;
      let bestScore = -Infinity;
      for (const j of grid.neighbors[current]) {
        if (!allowed[j]) continue;
        const dx = grid.lon[j] - grid.lon[current];
        const dy = grid.lat[j] - grid.lat[current];
        const norm = Math.hypot(dx, dy) || 1;
        const score = (dx * dirX + dy * dirY) / norm;
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      if (best < 0) break;
      current = best;
    }
  }
  return result;
}

/**
 * Рельеф по зафиксированным берегам: где сейчас море — остаётся море,
 * где суша — заново лепится рельеф. Внутренние области поднимаются
 * (континентальный подъём), по коллизиям плит и синтетическим хребтам
 * вырастают горы, сверху ложится шум.
 */
function generateTerrainOnCoast(
  grid: Grid,
  options: LandformOptions,
  seaLevel: number,
  random: () => number,
  log: string[],
): boolean {
  const isLand = new Uint8Array(grid.count);
  let landCount = 0;
  for (let i = 0; i < grid.count; i++) {
    if (grid.height[i] >= seaLevel) {
      isLand[i] = 1;
      landCount += 1;
    }
  }
  if (landCount < 12) {
    log.push('Суши на карте почти нет — берега сохранять нечего, генерирую рельеф с нуля');
    return false;
  }

  // расстояние от берега внутрь материка: чем дальше, тем выше «плато»
  const coast: number[] = [];
  for (let i = 0; i < grid.count; i++) {
    if (!isLand[i]) continue;
    if (grid.neighbors[i].some((j) => !isLand[j])) coast.push(i);
  }
  const fromCoast = graphDistance(grid, coast.length > 0 ? coast : [0]);
  let maxDistance = 1;
  for (let i = 0; i < grid.count; i++) if (isLand[i]) maxDistance = Math.max(maxDistance, fromCoast[i]);

  // хребты: коллизии плит, попавшие на сушу, плюс синтетические
  const plates = buildPlates(grid, Math.max(2, Math.min(24, options.plates)), random);
  const { convergent } = plateBoundaries(grid, plates);
  const ridgeSeeds = convergent.filter((index) => isLand[index]);
  const wanted = Math.max(1, Math.round(landCount / 700));
  if (ridgeSeeds.length < landCount * 0.01) {
    ridgeSeeds.push(
      ...synthesizeRidges(grid, isLand, random, wanted, Math.max(8, Math.round(Math.sqrt(landCount) * 1.6))),
    );
  }
  const fromRidge = ridgeSeeds.length > 0 ? graphDistance(grid, ridgeSeeds) : null;

  const noise = meshNoise(grid, random);
  const roughness = Math.min(1, Math.max(0, options.roughness));
  const span = 100 - seaLevel;

  for (let i = 0; i < grid.count; i++) {
    if (!isLand[i]) continue;
    const inland = Math.min(1, fromCoast[i] / Math.max(3, maxDistance * 0.7));
    let value = seaLevel + 1.5 + Math.pow(inland, 0.75) * span * 0.28;
    if (fromRidge) {
      const distance = fromRidge[i];
      if (distance >= 0) value += span * 0.62 * Math.exp(-distance / (2.2 + roughness * 2.4));
    }
    value += noise[i] * span * 0.18 * roughness;
    grid.height[i] = Math.min(100, Math.max(seaLevel + 0.5, value));
  }

  // мягкое сглаживание только по суше, чтобы не появилась «крупа»
  for (let pass = 0; pass < 2; pass++) {
    const next = Float64Array.from(grid.height);
    for (let i = 0; i < grid.count; i++) {
      if (!isLand[i]) continue;
      let sum = grid.height[i];
      let n = 1;
      for (const j of grid.neighbors[i]) {
        if (!isLand[j]) continue;
        sum += grid.height[j];
        n += 1;
      }
      next[i] = Math.max(seaLevel + 0.5, grid.height[i] * 0.55 + (sum / n) * 0.45);
    }
    grid.height.set(next);
  }

  log.push(
    `Рельеф по берегам: суши ${landCount} ячеек, хребтовых ячеек ${ridgeSeeds.length}, ` +
      `максимальная высота ${Math.round(Math.max(...grid.height))}`,
  );
  return true;
}

function generateTerrain(
  grid: Grid,
  options: LandformOptions,
  seaLevel: number,
  random: () => number,
  log: string[],
): void {
  const plateCount = Math.max(2, Math.min(24, options.plates));

  const plates = buildPlates(grid, plateCount, random);
  const { plate, continental } = plates;

  const baseHeight = new Float64Array(plateCount);
  for (let p = 0; p < plateCount; p++) {
    baseHeight[p] = continental[p] ? 28 + random() * 18 : 6 + random() * 8;
  }
  for (let i = 0; i < grid.count; i++) grid.height[i] = baseHeight[plate[i]];

  const { convergent, divergent } = plateBoundaries(grid, plates);

  if (convergent.length > 0) {
    const distance = graphDistance(grid, convergent);
    for (let i = 0; i < grid.count; i++) {
      const d = distance[i];
      if (d < 0) continue;
      const falloff = Math.exp(-d / 3.2);
      const boost = continental[plate[i]] ? 62 : 34;
      grid.height[i] += boost * falloff;
    }
  }
  if (divergent.length > 0) {
    const distance = graphDistance(grid, divergent);
    for (let i = 0; i < grid.count; i++) {
      const d = distance[i];
      if (d < 0) continue;
      grid.height[i] -= 20 * Math.exp(-d / 2.4);
    }
  }

  // --- фрактальный шум и нормировка под нужную долю моря
  const noise = meshNoise(grid, random);
  const amplitude = 26 * Math.min(1, Math.max(0, options.roughness));
  for (let i = 0; i < grid.count; i++) grid.height[i] += noise[i] * amplitude;

  // лёгкое сглаживание: тектоника с шумом оставляет слишком много ямок,
  // из которых потом получаются озёра на каждом шагу
  smoothHeights(grid, 2, 0.5);

  // отступ от рамки: у краёв карты рельеф уводится под воду, чтобы материки
  // выглядели целыми, а не обрезанными по границе изображения
  if (options.edgeFalloff > 0) {
    let min = Infinity;
    for (let i = 0; i < grid.count; i++) min = Math.min(min, grid.height[i]);
    for (let i = 0; i < grid.count; i++) {
      const weight = insideness(grid, i, options.edgeFalloff);
      grid.height[i] = min + (grid.height[i] - min) * weight;
    }
  }

  normalizeToSeaShare(grid, options.seaShare, seaLevel);
  log.push(
    `Тектоника: плит ${plateCount} (континентальных ${
      [...continental].filter(Boolean).length
    }), границ сближения ${convergent.length / 2}, расхождения ${divergent.length / 2}` +
      (options.edgeFalloff > 0 ? `, отступ от краёв ${Math.round(options.edgeFalloff * 100)}%` : ''),
  );
}

/** Сглаживание высот по соседям: `strength` — доля усреднения на проход. */
function smoothHeights(grid: Grid, passes: number, strength: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const next = Float64Array.from(grid.height);
    for (let i = 0; i < grid.count; i++) {
      const neighbors = grid.neighbors[i];
      if (neighbors.length === 0) continue;
      let sum = 0;
      for (const j of neighbors) sum += grid.height[j];
      const average = sum / neighbors.length;
      next[i] = grid.height[i] * (1 - strength) + average * strength;
    }
    grid.height.set(next);
  }
}

/**
 * Растянуть высоты так, чтобы заданная доля ячеек оказалась ниже уровня моря.
 * Иначе результат тектоники — либо сплошной океан, либо сплошная суша.
 */
function normalizeToSeaShare(grid: Grid, seaShare: number, seaLevel: number): void {
  const share = Math.min(0.95, Math.max(0.05, seaShare));
  const sorted = Float64Array.from(grid.height).sort();
  const pivot = sorted[Math.floor(share * (sorted.length - 1))];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  for (let i = 0; i < grid.count; i++) {
    const value = grid.height[i];
    const scaled =
      value <= pivot
        ? ((value - min) / Math.max(1e-6, pivot - min)) * seaLevel
        : seaLevel + ((value - pivot) / Math.max(1e-6, max - pivot)) * (100 - seaLevel);
    grid.height[i] = Math.min(100, Math.max(0, scaled));
  }
}

/* ------------------------------------------------------------------ */
/* 2. морские течения                                                  */
/* ------------------------------------------------------------------ */

interface Currents {
  /** скорость по долготе и широте для водных ячеек */
  vx: Float64Array;
  vy: Float64Array;
  /** поправка к температуре поверхности воды от переноса тепла, °C */
  sst: Float64Array;
  lines: Array<Feature<Geometry, CurrentProperties>>;
}

/**
 * Поверхностные течения.
 *
 * Физика в двух движениях: ветер тянет воду, а Кориолис отклоняет перенос
 * вправо в северном полушарии и влево в южном (перенос Экмана). Дальше поле
 * несколько раз расслабляется по соседям и «прижимается» к берегам —
 * составляющая, направленная в сушу, убирается, поэтому вдоль материков поток
 * идёт вдоль берега и замыкается в круговороты.
 *
 * Обратная связь на климат: течение, уходящее от экватора, несёт тёплую воду
 * (западные пограничные течения), идущее к экватору — холодную. Отсюда берутся
 * тёплые побережья и холодные прибрежные пустыни.
 */
function simulateCurrents(
  grid: Grid,
  world: World,
  seaLevel: number,
  equatorLat: number,
  log: string[],
): Currents {
  const bands = world.layers.winds?.bands ?? [225, 45, 225, 315, 135, 315];
  const { count, neighbors } = grid;
  const isWater = new Uint8Array(count);
  let waterCount = 0;
  for (let i = 0; i < count; i++) {
    if (grid.height[i] < seaLevel) {
      isWater[i] = 1;
      waterCount += 1;
    }
  }

  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const sst = new Float64Array(count);
  if (waterCount < 20) {
    log.push('Течения: воды почти нет, пропускаю');
    return { vx, vy, sst, lines: [] };
  }

  // ветровое воздействие с отклонением Экмана
  const forceX = new Float64Array(count);
  const forceY = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (!isWater[i]) continue;
    const wind = windVectorAt(bands, grid.lat[i], { equatorLat });
    if (!wind) continue;
    const hemisphere = grid.lat[i] >= equatorLat ? 1 : -1;
    const deflection = (35 * Math.PI) / 180 * hemisphere;
    const cos = Math.cos(deflection);
    const sin = Math.sin(deflection);
    forceX[i] = wind[0] * cos - wind[1] * sin;
    forceY[i] = wind[0] * sin + wind[1] * cos;
    vx[i] = forceX[i];
    vy[i] = forceY[i];
  }

  // расслабление поля и прижатие к берегам
  for (let pass = 0; pass < 14; pass++) {
    const nextX = Float64Array.from(vx);
    const nextY = Float64Array.from(vy);
    for (let i = 0; i < count; i++) {
      if (!isWater[i]) continue;
      let sumX = 0;
      let sumY = 0;
      let waterNeighbors = 0;
      let landX = 0;
      let landY = 0;
      let landNeighbors = 0;
      for (const j of neighbors[i]) {
        const dx = grid.lon[j] - grid.lon[i];
        const dy = grid.lat[j] - grid.lat[i];
        const norm = Math.hypot(dx, dy) || 1;
        if (isWater[j]) {
          sumX += vx[j];
          sumY += vy[j];
          waterNeighbors += 1;
        } else {
          landX += dx / norm;
          landY += dy / norm;
          landNeighbors += 1;
        }
      }
      let x = vx[i] * 0.45 + forceX[i] * 0.25;
      let y = vy[i] * 0.45 + forceY[i] * 0.25;
      if (waterNeighbors > 0) {
        x += (sumX / waterNeighbors) * 0.3;
        y += (sumY / waterNeighbors) * 0.3;
      }
      if (landNeighbors > 0) {
        // убираем составляющую «в берег» — поток идёт вдоль него
        const norm = Math.hypot(landX, landY) || 1;
        const nx = landX / norm;
        const ny = landY / norm;
        const into = x * nx + y * ny;
        if (into > 0) {
          x -= nx * into;
          y -= ny * into;
        }
      }
      nextX[i] = x;
      nextY[i] = y;
    }
    vx.set(nextX);
    vy.set(nextY);
  }

  // перенос тепла: движение от экватора — тёплое, к экватору — холодное
  for (let i = 0; i < count; i++) {
    if (!isWater[i]) continue;
    const speed = Math.hypot(vx[i], vy[i]);
    if (speed < 1e-6) continue;
    const poleward = (vy[i] / speed) * Math.sign(grid.lat[i] - equatorLat || 1);
    const strength = Math.min(1, speed);
    sst[i] = poleward * strength * 4.5;
  }
  // размазываем поправку, чтобы не было пятен по одной ячейке
  for (let pass = 0; pass < 3; pass++) {
    const next = Float64Array.from(sst);
    for (let i = 0; i < count; i++) {
      let sum = sst[i];
      let n = 1;
      for (const j of neighbors[i]) {
        sum += sst[j];
        n += 1;
      }
      next[i] = sum / n;
    }
    sst.set(next);
  }

  /* --- линии тока для отрисовки --- */
  const lines: Array<Feature<Geometry, CurrentProperties>> = [];
  const step = Math.max(1, Math.round(waterCount / 60));
  const waterCells: number[] = [];
  for (let i = 0; i < count; i++) if (isWater[i]) waterCells.push(i);

  const nearestWater = (lon: number, lat: number, from: number): number => {
    let best = -1;
    let bestDistance = Infinity;
    for (const j of grid.neighbors[from]) {
      if (!isWater[j]) continue;
      const distance = (grid.lon[j] - lon) ** 2 + (grid.lat[j] - lat) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = j;
      }
    }
    return best;
  };

  for (let s = 0; s < waterCells.length; s += step) {
    let current = waterCells[s];
    const points: Position[] = [];
    let lon = grid.lon[current];
    let lat = grid.lat[current];
    let startLat = lat;
    let speedSum = 0;
    for (let stepIndex = 0; stepIndex < 20; stepIndex++) {
      points.push([Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000]);
      const speed = Math.hypot(vx[current], vy[current]);
      if (speed < 0.05) break;
      speedSum += speed;
      const stepSize = 1.1;
      lon += (vx[current] / speed) * stepSize;
      lat += (vy[current] / speed) * stepSize;
      const next = nearestWater(lon, lat, current);
      if (next < 0) break;
      current = next;
      // притягиваем точку к центру найденной водной ячейки: иначе линия
      // срезает угол и визуально ползёт по суше
      lon = lon * 0.35 + grid.lon[current] * 0.65;
      lat = lat * 0.35 + grid.lat[current] * 0.65;
    }
    if (points.length < 5) continue;
    const drift = (lat - startLat) * Math.sign(startLat - equatorLat || 1);
    lines.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points },
      properties: {
        id: `current-${lines.length}`,
        temperature: drift >= 0 ? 'warm' : 'cold',
        speed: Math.round(Math.min(1, speedSum / points.length) * 100) / 100,
      },
    });
  }

  log.push(
    `Течения: линий ${lines.length} (тёплых ${
      lines.filter((line) => line.properties.temperature === 'warm').length
    }), поправка температуры до ±${Math.round(Math.max(...sst.map(Math.abs)) * 10) / 10} °C`,
  );
  return { vx, vy, sst, lines };
}

/* ------------------------------------------------------------------ */
/* 3. климат                                                           */
/* ------------------------------------------------------------------ */

interface Climate {
  temperature: Float64Array;
  precipitation: Float64Array;
}

function simulateClimate(
  grid: Grid,
  world: World,
  seaLevel: number,
  currents: Currents | null,
  log: string[],
): Climate {
  const bands = world.layers.winds?.bands ?? [225, 45, 225, 315, 135, 315];
  const settings = world.meta.climate ?? {};
  const equatorLat = settings.equatorLat ?? 0;
  const temperature = new Float64Array(grid.count);
  const precipitation = new Float64Array(grid.count);
  const moisture = new Float64Array(grid.count);

  // температура: расстояние от экватора (он может быть смещён) плюс высотный
  // градиент около 6 °C на километр
  const equator = settings.temperatureEquator ?? 27;
  const pole = settings.temperaturePole ?? -24;
  for (let i = 0; i < grid.count; i++) {
    const latitudeFactor = Math.min(1, Math.abs(grid.lat[i] - equatorLat) / 90);
    const altitude = Math.max(0, grid.height[i] - seaLevel) * 40; // условные метры
    temperature[i] = equator - latitudeFactor * (equator - pole) - (altitude / 1000) * 6;
    if (currents) {
      // над водой поправка целиком, на суше — вдвое слабее (морской климат берегов)
      const delta = currents.sst[i];
      if (delta !== 0) temperature[i] += grid.height[i] < seaLevel ? delta : delta * 0.5;
    }
  }

  // осадки: влага идёт по ветру, испаряется над водой, выпадает при подъёме
  const bandCount = bands.length;
  const buckets: number[][] = Array.from({ length: bandCount }, () => []);
  for (let i = 0; i < grid.count; i++) {
    const normalized = Math.min(1, Math.max(0, (90 - (grid.lat[i] - equatorLat)) / 180));
    const band = Math.min(bandCount - 1, Math.max(0, Math.floor(normalized * bandCount)));
    buckets[band].push(i);
  }

  // масштаб подъёма: на сколько единиц высоты воздух должен подняться,
  // чтобы отдать заметную часть влаги. Считаем от реального перепада мира,
  // иначе модель работает только для шкалы 0..100
  let maxHeight = seaLevel + 1;
  for (let i = 0; i < grid.count; i++) maxHeight = Math.max(maxHeight, grid.height[i]);
  const riseScale = Math.max(1, (maxHeight - seaLevel) * 0.06);
  const highRidge = seaLevel + (maxHeight - seaLevel) * 0.55;

  for (let band = 0; band < bandCount; band++) {
    const cells = buckets[band];
    if (cells.length === 0) continue;
    const middleLat = cells.reduce((sum, i) => sum + grid.lat[i], 0) / cells.length;
    const angle = (((windAngleAt(bands, middleLat, { equatorLat }) ?? 270) - 90) * Math.PI) / 180;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const projection = (i: number): number => grid.lon[i] * dirX + grid.lat[i] * dirY;
    cells.sort((a, b) => projection(a) - projection(b));

    for (const i of cells) {
      const own = projection(i);

      /*
       * Влага приходит с наветренной стороны, и вклад соседа взвешивается по
       * тому, насколько он «прямо по ветру». Без этого веса воздух обтекает
       * хребет боком и дождевой тени не получается — именно это и было заметно.
       */
      let incoming = 0;
      let upwindHeight = 0;
      let weightSum = 0;
      for (const j of grid.neighbors[i]) {
        const other = projection(j);
        if (other >= own) continue;
        const dx = grid.lon[i] - grid.lon[j];
        const dy = grid.lat[i] - grid.lat[j];
        const norm = Math.hypot(dx, dy) || 1;
        const alignment = (dx * dirX + dy * dirY) / norm;
        if (alignment <= 0) continue;
        const weight = alignment * alignment;
        incoming += moisture[j] * weight;
        upwindHeight += grid.height[j] * weight;
        weightSum += weight;
      }

      let water = weightSum > 0 ? incoming / weightSum : 0.3;
      const averageUpwind = weightSum > 0 ? upwindHeight / weightSum : grid.height[i];

      if (grid.height[i] < seaLevel) {
        // над водой влага пополняется, тем сильнее, чем теплее вода:
        // холодное течение = сухой воздух = прибрежная пустыня по ветру
        const warmth = Math.max(0, Math.min(1, (temperature[i] + 5) / 32));
        water = Math.min(1, Math.max(water, 0.45 + warmth * 0.5));
        precipitation[i] = 0.05 + warmth * 0.05;
        moisture[i] = water;
        continue;
      }

      const gain = grid.height[i] - averageUpwind;
      // подъём отдаёт влагу с насыщением: крутой склон снимает большую часть,
      // но не всё сразу — иначе первый же уступ у берега осушает материк целиком
      const orographic = gain > 0 ? 1 - Math.exp((-gain / riseScale) * 1.6) : 0;
      let fraction = Math.min(0.55, 0.03 + orographic * 0.75);
      if (gain < -0.5) {
        // подветренный склон: воздух опускается, нагревается и сушит — фён
        fraction *= 0.25;
      }

      const warmth = Math.max(0, Math.min(1, (temperature[i] + 5) / 32));
      const fall = Math.min(water, water * fraction);
      // плюс слабая конвекция: в тёплом климате дождь идёт и без хребтов
      precipitation[i] = fall + 0.004 * warmth * (0.3 + water);
      water = Math.max(0, water - fall);

      // за высоким хребтом воздух уходит уже выжатым
      if (grid.height[i] > highRidge) water *= 0.6;

      // испарение с суши частично возвращает влагу — материковая рециркуляция,
      // без неё вся внутренняя часть континента остаётся абсолютно сухой
      water = Math.min(1, water + (1 - water) * 0.03 * warmth);
      moisture[i] = water * 0.99;
    }
  }

  let land = 0;
  let sum = 0;
  for (let i = 0; i < grid.count; i++) {
    if (grid.height[i] < seaLevel) continue;
    land += 1;
    sum += precipitation[i];
  }
  log.push(
    `Климат: полос ветров ${bandCount}, экватор на широте ${equatorLat}°, ` +
      `${equator}…${pole} °C, средние осадки над сушей ${(land ? sum / land : 0).toFixed(3)}`,
  );
  return { temperature, precipitation };
}

/* ------------------------------------------------------------------ */
/* 3. гидрология: озёра и реки                                         */
/* ------------------------------------------------------------------ */

interface Hydrology {
  filled: Float64Array;
  flux: Float64Array;
  downstream: Int32Array;
  lake: Uint8Array;
  rivers: Array<Feature<Geometry, RiverProperties>>;
}

function simulateHydrology(
  grid: Grid,
  climate: Climate,
  seaLevel: number,
  options: LandformOptions,
  log: string[],
): Hydrology {
  const { count, neighbors } = grid;
  const filled = Float64Array.from(grid.height);
  const lake = new Uint8Array(count);

  /* --- priority-flood: заливаем впадины, оставляя минимальный уклон к морю --- */
  const epsilon = 0.001;
  const visited = new Uint8Array(count);
  const heap = new MinHeap();
  for (let i = 0; i < count; i++) {
    const isOcean = grid.height[i] < seaLevel;
    const onEdge = neighbors[i].length < 3;
    if (isOcean || onEdge) {
      visited[i] = 1;
      heap.push(filled[i], i);
    }
  }
  while (heap.size > 0) {
    const item = heap.pop()!;
    const current = item.value;
    for (const next of neighbors[current]) {
      if (visited[next]) continue;
      visited[next] = 1;
      if (filled[next] <= filled[current]) {
        filled[next] = filled[current] + epsilon;
        // озеро — только там, где воде действительно некуда деться:
        // мелкие «подтопления» от сглаживания рельефа озёрами не считаем
        if (filled[next] - grid.height[next] > LAKE_DEPTH) lake[next] = 1;
      }
      heap.push(filled[next], next);
    }
  }

  /* --- сток: каждая ячейка отдаёт воду самому низкому соседу --- */
  const downstream = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    if (grid.height[i] < seaLevel) continue;
    let best = -1;
    let bestHeight = filled[i];
    for (const j of neighbors[i]) {
      if (filled[j] < bestHeight) {
        bestHeight = filled[j];
        best = j;
      }
    }
    downstream[i] = best;
  }

  const flux = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    flux[i] = grid.height[i] >= seaLevel ? Math.max(0.001, climate.precipitation[i]) : 0;
  }
  const order = Array.from({ length: count }, (_value, i) => i)
    .filter((i) => grid.height[i] >= seaLevel)
    .sort((a, b) => filled[b] - filled[a]);
  for (const i of order) {
    const next = downstream[i];
    if (next >= 0) flux[next] += flux[i];
  }

  /* --- реки: там, где расход перешёл порог --- */
  let maxFlux = 0;
  for (let i = 0; i < count; i++) maxFlux = Math.max(maxFlux, flux[i]);
  const threshold = Math.max(1e-6, maxFlux * Math.min(0.9, Math.max(0.005, options.riverThreshold)));

  const isRiver = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (grid.height[i] >= seaLevel && flux[i] >= threshold && !lake[i]) isRiver[i] = 1;
  }

  // истоки: речная ячейка, в которую не втекает другая река
  const sources: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!isRiver[i]) continue;
    const hasRiverUpstream = neighbors[i].some((j) => isRiver[j] && downstream[j] === i);
    if (!hasRiverUpstream) sources.push(i);
  }

  const rivers: Array<Feature<Geometry, RiverProperties>> = [];
  const visitedEdge = new Set<string>();
  for (const [index, source] of sources.entries()) {
    const points: Position[] = [];
    let current = source;
    let guard = 0;
    let discharge = flux[source];
    while (current >= 0 && guard++ < count) {
      points.push([grid.lon[current], grid.lat[current]]);
      discharge = Math.max(discharge, flux[current]);
      const next = downstream[current];
      if (next < 0) break;
      const edgeKey = `${current}>${next}`;
      if (visitedEdge.has(edgeKey)) break; // дальше течёт уже описанная река
      visitedEdge.add(edgeKey);
      // доходим до моря или озера и останавливаемся
      points.push([grid.lon[next], grid.lat[next]]);
      if (grid.height[next] < seaLevel || lake[next]) break;
      current = next;
    }
    if (points.length < 2) continue;
    rivers.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: dedupe(points) },
      properties: {
        id: `river-sim-${index}`,
        name: undefined,
        type: 'River',
        discharge: Math.round((discharge / Math.max(1e-6, maxFlux)) * 100) / 10,
        width: Math.round((discharge / Math.max(1e-6, maxFlux)) * 100) / 100,
      },
    });
  }

  let lakeCells = 0;
  for (let i = 0; i < count; i++) if (lake[i]) lakeCells += 1;
  log.push(`Гидрология: озёрных ячеек ${lakeCells}, рек ${rivers.length}`);
  return { filled, flux, downstream, lake, rivers };
}

function dedupe(points: Position[]): Position[] {
  const result: Position[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    result.push(point);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 4. эрозия и биомы                                                   */
/* ------------------------------------------------------------------ */

/** Речная эрозия: чем больше расход, тем сильнее срезается склон. */
function erode(grid: Grid, hydrology: Hydrology, seaLevel: number, passes: number): void {
  const { flux, downstream } = hydrology;
  let maxFlux = 0;
  for (let i = 0; i < grid.count; i++) maxFlux = Math.max(maxFlux, flux[i]);
  if (maxFlux <= 0) return;

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < grid.count; i++) {
      if (grid.height[i] < seaLevel) continue;
      const next = downstream[i];
      if (next < 0) continue;
      const drop = grid.height[i] - grid.height[next];
      if (drop <= 0) continue;
      const power = Math.sqrt(flux[i] / maxFlux);
      // суша не должна уйти под воду: береговая линия — обещание, которое нельзя ломать
      grid.height[i] = Math.max(seaLevel + 0.05, grid.height[i] - Math.min(drop * 0.5, power * 3.2));
    }
  }
}

/**
 * Перцентильный ранг значения среди суши, 0..1.
 *
 * Биомы считаем по ОТНОСИТЕЛЬНОЙ влажности, а не по абсолютным миллиметрам:
 * абсолютная шкала зависит от размера карты и настроек ветров, и на одном мире
 * даёт сплошную пустыню, на другом — сплошные джунгли.
 */
function percentileRanks(values: Float64Array, isLand: Uint8Array): Float64Array {
  const ranks = new Float64Array(values.length);
  const indices: number[] = [];
  for (let i = 0; i < values.length; i++) if (isLand[i]) indices.push(i);
  if (indices.length === 0) return ranks;
  indices.sort((a, b) => values[a] - values[b]);
  const last = Math.max(1, indices.length - 1);
  indices.forEach((index, position) => {
    ranks[index] = position / last;
  });
  return ranks;
}

/** Биом по температуре, относительной влажности, высоте и воде — в духе Уиттекера. */
function biomeFor(
  height: number,
  seaLevel: number,
  temperature: number,
  wetness: number,
  lake: boolean,
  wetland: boolean,
): string {
  if (lake) return 'Lake';
  if (height < seaLevel) return 'Marine';
  if (temperature < -6) return 'Glacier';
  if (temperature < -1) return 'Tundra';
  if (wetland) return 'Wetland';
  if (wetness < 0.14) return temperature > 16 ? 'Hot desert' : 'Cold desert';
  if (temperature < 4) return 'Taiga';
  if (wetness > 0.84) return temperature > 20 ? 'Tropical rainforest' : 'Temperate rainforest';
  if (wetness > 0.55) return temperature > 20 ? 'Tropical seasonal forest' : 'Temperate deciduous forest';
  if (temperature > 23 && wetness < 0.4) return 'Savanna';
  return 'Grassland';
}

/* ------------------------------------------------------------------ */
/* пайплайн                                                            */
/* ------------------------------------------------------------------ */

/**
 * Прогнать симуляцию и записать результат в мир. Мутирует переданный мир —
 * вызывать внутри commit(). Возвращает журнал по этапам.
 */
export function simulateLandform(world: World, options: LandformOptions): string[] {
  const log: string[] = [];
  if (world.cells.features.length === 0) {
    throw new Error('Симуляции нужна сетка ячеек: создайте карту или импортируйте мир');
  }

  const seaLevel = seaLevelOf(world);
  const random = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));
  const grid = buildGrid(world);
  log.push(`Ячеек в модели: ${grid.count}, уровень моря ${seaLevel}`);

  if (options.terrain) {
    const keptCoast = options.respectCoastline
      ? generateTerrainOnCoast(grid, options, seaLevel, random, log)
      : false;
    if (!keptCoast) generateTerrain(grid, options, seaLevel, random, log);
  }

  const equatorLat = world.meta.climate?.equatorLat ?? 0;
  let currents: Currents | null = null;
  if (options.currents) {
    currents = simulateCurrents(grid, world, seaLevel, equatorLat, log);
  }

  let climate: Climate = {
    temperature: new Float64Array(grid.count),
    precipitation: new Float64Array(grid.count),
  };
  if (options.climate || options.hydrology || options.biomes) {
    climate = simulateClimate(grid, world, seaLevel, currents, log);
  }

  let hydrology: Hydrology | null = null;
  if (options.hydrology) {
    hydrology = simulateHydrology(grid, climate, seaLevel, options, log);
    if (options.erosion > 0) {
      erode(grid, hydrology, seaLevel, Math.min(8, options.erosion));
      // после эрозии рельеф изменился — пересчитываем воду по новому
      hydrology = simulateHydrology(grid, climate, seaLevel, options, log);
      log.push(`Эрозия: проходов ${Math.min(8, options.erosion)}`);
    }
  }

  /* --- запись результата в мир --- */
  const isLand = new Uint8Array(grid.count);
  for (let i = 0; i < grid.count; i++) isLand[i] = grid.height[i] >= seaLevel ? 1 : 0;
  const wetnessRank = percentileRanks(climate.precipitation, isLand);
  const fluxRank = hydrology ? percentileRanks(hydrology.flux, isLand) : new Float64Array(grid.count);

  const topology = topologyOf(world);
  for (let i = 0; i < grid.count; i++) {
    const cell = topology.byId.get(grid.ids[i]);
    if (!cell) continue;
    const properties = cell.properties as Record<string, unknown>;

    if (options.terrain || (options.hydrology && options.erosion > 0)) {
      properties.height = Math.round(grid.height[i] * 100) / 100;
    }
    if (options.climate) {
      properties.temperature = Math.round(climate.temperature[i] * 10) / 10;
      properties.precipitation = Math.round(climate.precipitation[i] * 1000) / 1000;
    }
    if (hydrology) {
      const isLake = hydrology.lake[i] === 1;
      if (isLake) properties.lake = true;
      else delete properties.lake;
      properties.flux = Math.round(hydrology.flux[i] * 1000) / 1000;
    }
    if (options.biomes) {
      const isLake = hydrology ? hydrology.lake[i] === 1 : false;
      // болото: много воды приходит, а уклона почти нет и место низкое
      const wetland =
        hydrology !== null &&
        fluxRank[i] > 0.9 &&
        wetnessRank[i] > 0.45 &&
        grid.height[i] < seaLevel + 6 &&
        climate.temperature[i] > 2;
      properties.biome = biomeFor(
        grid.height[i],
        seaLevel,
        climate.temperature[i],
        wetnessRank[i],
        isLake,
        wetland,
      );
    }
  }

  if (hydrology) {
    world.layers.rivers = { type: 'FeatureCollection', features: hydrology.rivers };
  }
  if (currents) {
    world.layers.currents = { type: 'FeatureCollection', features: currents.lines };
  }
  if (options.terrain || (options.hydrology && options.erosion > 0)) {
    // растровая сетка описывала прежний рельеф и больше не соответствует ячейкам
    if (world.layers.heightmap) delete world.layers.heightmap;
  }

  return log;
}
