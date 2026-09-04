/**
 * d3-geo трактует полигоны как сферические и требует, чтобы ВНЕШНЕЕ кольцо шло
 * по часовой стрелке (обратно соглашению RFC 7946, которого держатся Azgaar и
 * большинство редакторов). Кольцо «наоборот» превращает клетку в «всё, кроме клетки»,
 * и карта заливается одним цветом. Поэтому на импорте перематываем все кольца.
 */
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';

function signedArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0, length = ring.length; i < length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** clockwise=true -> внешнее кольцо; false -> дырка. */
function rewindRing(ring: Position[], clockwise: boolean): Position[] {
  const area = signedArea(ring);
  const isClockwise = area < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

function rewindPolygon(rings: Position[][]): Position[][] {
  return rings.map((ring, index) => rewindRing(ring, index === 0));
}

export function rewindGeometry(geometry: Geometry): Geometry {
  switch (geometry.type) {
    case 'Polygon':
      return { ...geometry, coordinates: rewindPolygon(geometry.coordinates) };
    case 'MultiPolygon':
      return { ...geometry, coordinates: geometry.coordinates.map(rewindPolygon) };
    case 'GeometryCollection':
      return { ...geometry, geometries: geometry.geometries.map(rewindGeometry) };
    default:
      return geometry;
  }
}

export function rewindFeatures<P>(collection: FeatureCollection<Geometry, P> | undefined): void {
  if (!collection) return;
  for (const feature of collection.features as Feature<Geometry, P>[]) {
    if (feature.geometry) feature.geometry = rewindGeometry(feature.geometry);
  }
}
