/**
 * Нерегулярная сетка ячеек (Voronoi по подрагивающей решётке точек).
 *
 * Именно она даёт «живые» границы: соседние ячейки с одинаковым атрибутом
 * растворяются в область с неровным, естественным контуром — а не в квадраты.
 * Импорт из Azgaar приносит свою сетку, эта нужна для демо-мира и рисования с нуля.
 */
import { Delaunay } from 'd3-delaunay';
import type { Position } from 'geojson';

export interface MeshCell {
  index: number;
  /** замкнутое кольцо в координатах bbox (долгота/широта) */
  ring: Position[];
  lon: number;
  lat: number;
}

export interface MeshOptions {
  bbox: [number, number, number, number];
  /** желаемое число ячеек */
  count: number;
  random?: () => number;
  /** сила смещения точек от центров решётки, 0..0.5 */
  jitter?: number;
}

export function buildVoronoiMesh(options: MeshOptions): MeshCell[] {
  const [minLon, minLat, maxLon, maxLat] = options.bbox;
  const random = options.random ?? Math.random;
  const jitter = options.jitter ?? 0.42;

  const width = maxLon - minLon;
  const height = maxLat - minLat;
  const columns = Math.max(2, Math.round(Math.sqrt((options.count * width) / height)));
  const rows = Math.max(2, Math.round(options.count / columns));
  const stepX = width / columns;
  const stepY = height / rows;

  const points: Array<[number, number]> = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const lon = minLon + (column + 0.5 + (random() - 0.5) * 2 * jitter) * stepX;
      const lat = minLat + (row + 0.5 + (random() - 0.5) * 2 * jitter) * stepY;
      points.push([
        Math.min(maxLon, Math.max(minLon, lon)),
        Math.min(maxLat, Math.max(minLat, lat)),
      ]);
    }
  }

  const delaunay = Delaunay.from(points);
  const voronoi = delaunay.voronoi([minLon, minLat, maxLon, maxLat]);

  const cells: MeshCell[] = [];
  for (let index = 0; index < points.length; index++) {
    const polygon = voronoi.cellPolygon(index);
    if (!polygon || polygon.length < 4) continue;
    // d3-delaunay уже возвращает замкнутое кольцо; координаты округляем,
    // чтобы вершины соседних ячеек совпадали при растворении границ
    const ring: Position[] = polygon.map(([x, y]) => [round(x), round(y)] as Position);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push([...ring[0]] as Position);
    }
    cells.push({ index, ring, lon: points[index][0], lat: points[index][1] });
  }
  return cells;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
