/**
 * Растворение (dissolve) ячеек в цельные области.
 *
 * Тематические и политические слои не должны выглядеть мозаикой из ячеек: соседние
 * ячейки с одинаковым значением атрибута сливаются в одну область, а её контур — это
 * рёбра, у которых по другую сторону другое значение. Общие рёбра встречаются дважды
 * (в противоположных направлениях) и взаимно уничтожаются; остаётся граница, которую
 * можно нарисовать одной обводкой и сгладить.
 */
import type { Feature, Geometry, Position } from 'geojson';

/** Квантование координат: вершины соседних ячеек должны совпадать бит-в-бит по ключу. */
const QUANT = 1e6;

function pointKey(point: Position): string {
  return `${Math.round(point[0] * QUANT)}:${Math.round(point[1] * QUANT)}`;
}

function ringsOf(geometry: Geometry | null | undefined): Position[][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as Position[][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Position[][][]).flat();
  return [];
}

function signedArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0, length = ring.length; i < length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Сглаживание Чайкина для замкнутого кольца: границы становятся плавными, а не «пилой». */
function chaikin(ring: Position[], iterations: number): Position[] {
  let current = ring;
  for (let step = 0; step < iterations; step++) {
    const closed = current.length > 1 && pointKey(current[0]) === pointKey(current[current.length - 1]);
    const points = closed ? current.slice(0, -1) : current;
    if (points.length < 4) return current;
    const next: Position[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push([...next[0]] as Position);
    current = next;
  }
  return current;
}

interface DirectedEdge {
  from: Position;
  to: Position;
  fromKey: string;
  toKey: string;
}

/** Собрать замкнутые кольца из набора граничных рёбер. */
function stitchRings(edges: DirectedEdge[]): Position[][] {
  const byStart = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const bucket = byStart.get(edge.fromKey);
    if (bucket) bucket.push(index);
    else byStart.set(edge.fromKey, [index]);
  });

  const used = new Array<boolean>(edges.length).fill(false);
  const rings: Position[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const ring: Position[] = [edges[start].from];
    let current = start;
    used[current] = true;
    const startKey = edges[start].fromKey;

    for (let guard = 0; guard < edges.length + 2; guard++) {
      ring.push(edges[current].to);
      if (edges[current].toKey === startKey) break;
      const candidates = byStart.get(edges[current].toKey);
      const next = candidates?.find((index) => !used[index]);
      if (next === undefined) break; // разрыв (несогласованные координаты) — замыкаем как есть
      used[next] = true;
      current = next;
    }

    if (ring.length >= 4) {
      if (pointKey(ring[0]) !== pointKey(ring[ring.length - 1])) ring.push([...ring[0]] as Position);
      rings.push(ring);
    }
  }
  return rings;
}

/** Кольца -> полигоны: внешние (по часовой) + вложенные в них дырки (против часовой). */
function ringsToPolygons(rings: Position[][]): Position[][][] {
  const outers: Position[][] = [];
  const holes: Position[][] = [];
  for (const ring of rings) {
    if (signedArea(ring) < 0) outers.push(ring);
    else holes.push(ring);
  }
  if (outers.length === 0) return rings.map((ring) => [ring]);

  const polygons: Position[][][] = outers.map((ring) => [ring]);
  for (const hole of holes) {
    let bestIndex = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (!pointInRing(hole[0], outers[i])) continue;
      const area = Math.abs(signedArea(outers[i]));
      if (area < bestArea) {
        bestArea = area;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) polygons[bestIndex].push(hole);
    else polygons.push([hole]);
  }
  return polygons;
}

export interface DissolveOptions {
  /** число итераций сглаживания Чайкина (0 — оставить исходные рёбра) */
  smoothing?: number;
}

/**
 * Растворить фичи по ключу. Возвращает для каждого ключа координаты MultiPolygon.
 */
export function dissolveByKey<P>(
  features: Array<Feature<Geometry, P>>,
  keyOf: (feature: Feature<Geometry, P>) => string | null | undefined,
  options: DissolveOptions = {},
): Map<string, Position[][][]> {
  const groups = new Map<string, Array<Feature<Geometry, P>>>();
  for (const feature of features) {
    const key = keyOf(feature);
    if (key === null || key === undefined || key === '') continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(feature);
    else groups.set(key, [feature]);
  }

  const smoothing = options.smoothing ?? 0;
  const result = new Map<string, Position[][][]>();

  for (const [key, bucket] of groups) {
    const directed = new Map<string, DirectedEdge>();
    const undirected = new Map<string, number>();

    for (const feature of bucket) {
      for (const ring of ringsOf(feature.geometry)) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const from = ring[i];
          const to = ring[i + 1];
          const fromKey = pointKey(from);
          const toKey = pointKey(to);
          if (fromKey === toKey) continue;
          directed.set(`${fromKey}>${toKey}`, { from, to, fromKey, toKey });
          const pairKey = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
          undirected.set(pairKey, (undirected.get(pairKey) ?? 0) + 1);
        }
      }
    }

    const boundary: DirectedEdge[] = [];
    for (const edge of directed.values()) {
      const pairKey =
        edge.fromKey < edge.toKey ? `${edge.fromKey}|${edge.toKey}` : `${edge.toKey}|${edge.fromKey}`;
      if ((undirected.get(pairKey) ?? 0) === 1) boundary.push(edge);
    }
    if (boundary.length === 0) continue;

    let rings = stitchRings(boundary);
    if (smoothing > 0) rings = rings.map((ring) => chaikin(ring, smoothing));
    result.set(key, ringsToPolygons(rings));
  }

  return result;
}

/** Соседство ячеек по общим рёбрам (нужно для сглаживания рельефа и чистки берега). */
export function buildAdjacency<P extends { id: string }>(
  features: Array<Feature<Geometry, P>>,
): Map<string, string[]> {
  const byEdge = new Map<string, string[]>();
  for (const feature of features) {
    const id = feature.properties.id;
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = pointKey(ring[i]);
        const b = pointKey(ring[i + 1]);
        if (a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const bucket = byEdge.get(key);
        if (bucket) {
          if (!bucket.includes(id)) bucket.push(id);
        } else {
          byEdge.set(key, [id]);
        }
      }
    }
  }

  const neighbors = new Map<string, Set<string>>();
  for (const ids of byEdge.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      let set = neighbors.get(id);
      if (!set) {
        set = new Set();
        neighbors.set(id, set);
      }
      for (const other of ids) if (other !== id) set.add(other);
    }
  }

  const result = new Map<string, string[]>();
  for (const [id, set] of neighbors) result.set(id, [...set]);
  return result;
}
