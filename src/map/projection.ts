import { geoEquirectangular, geoMercator, geoNaturalEarth1, type GeoProjection } from 'd3-geo';
import type { FeatureCollection, Geometry } from 'geojson';
import type { ProjectionId } from '../state/types';

export function makeProjection(id: ProjectionId | undefined): GeoProjection {
  switch (id) {
    case 'mercator':
      return geoMercator();
    case 'naturalEarth':
      return geoNaturalEarth1();
    default:
      return geoEquirectangular();
  }
}

/**
 * Одна общая проекция на все слои: подгоняется под данные мира,
 * дальше зум/пан живут в трансформе d3-zoom, а не в проекции.
 */
export function fitProjection(
  projection: GeoProjection,
  data: FeatureCollection<Geometry, unknown> | null,
  width: number,
  height: number,
  padding = 12,
): GeoProjection {
  const box: [[number, number], [number, number]] = [
    [padding, padding],
    [Math.max(padding + 1, width - padding), Math.max(padding + 1, height - padding)],
  ];
  if (data && data.features.length > 0) {
    projection.fitExtent(box, data as never);
  } else {
    projection.fitExtent(box, { type: 'Sphere' } as never);
  }
  return projection;
}
