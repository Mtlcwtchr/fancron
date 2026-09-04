/**
 * Пустая карта заданного размера — точка старта, когда мир рисуется с нуля,
 * а не импортируется. Сетка ячеек создаётся сразу: без неё не работают кисти,
 * потому что все инструменты правят атрибуты ячеек.
 */
import type { Feature, Geometry } from 'geojson';
import { biomeForConditions } from '../util/biome';
import { buildVoronoiMesh } from '../util/mesh';
import { mulberry32 } from '../util/random';
import { SCHEMA_VERSION, emptyWorld, type CellProperties, type World } from '../state/types';

export type ReliefPreset = 'ocean' | 'land' | 'continents';

export interface BlankWorldOptions {
  name: string;
  /** ширина карты в градусах долготы */
  lonSpan: number;
  /** высота карты в градусах широты */
  latSpan: number;
  /** желаемое число ячеек: чем больше, тем тоньше границы и медленнее правки */
  cells: number;
  relief: ReliefPreset;
  seed?: number;
}

export const DEFAULT_BLANK_OPTIONS: BlankWorldOptions = {
  name: 'Новый мир',
  lonSpan: 200,
  latSpan: 100,
  cells: 4000,
  relief: 'continents',
};

const SEA_LEVEL = 20;

interface Blob {
  lon: number;
  lat: number;
  radius: number;
  amplitude: number;
}

function makeBlobs(random: () => number, lonSpan: number, latSpan: number): Blob[] {
  const count = 3 + Math.floor(random() * 4);
  const blobs: Blob[] = [];
  for (let i = 0; i < count; i++) {
    blobs.push({
      lon: (random() - 0.5) * lonSpan * 0.7,
      lat: (random() - 0.5) * latSpan * 0.7,
      radius: (0.12 + random() * 0.22) * Math.min(lonSpan, latSpan * 2),
      amplitude: 45 + random() * 45,
    });
  }
  return blobs;
}

function heightFromBlobs(blobs: Blob[], lon: number, lat: number): number {
  let height = 4;
  for (const blob of blobs) {
    const distance = Math.hypot(lon - blob.lon, (lat - blob.lat) * 1.6);
    if (distance >= blob.radius) continue;
    const falloff = 1 - distance / blob.radius;
    height += blob.amplitude * falloff * falloff;
  }
  return Math.min(100, Math.round(height));
}

export function createBlankWorld(options: BlankWorldOptions): World {
  const lonSpan = Math.min(360, Math.max(10, options.lonSpan));
  const latSpan = Math.min(170, Math.max(10, options.latSpan));
  const cellCount = Math.min(30000, Math.max(200, Math.round(options.cells)));
  const random = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));

  const bbox: [number, number, number, number] = [-lonSpan / 2, -latSpan / 2, lonSpan / 2, latSpan / 2];
  const mesh = buildVoronoiMesh({ bbox, count: cellCount, random, jitter: 0.45 });
  const blobs = options.relief === 'continents' ? makeBlobs(random, lonSpan, latSpan) : [];

  const features: Array<Feature<Geometry, CellProperties>> = mesh.map((cell, index) => {
    const height =
      options.relief === 'ocean'
        ? 8
        : options.relief === 'land'
          ? 40
          : heightFromBlobs(blobs, cell.lon, cell.lat);
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [cell.ring] },
      properties: {
        id: `cell-${index}`,
        height,
        biome: biomeForConditions(height, cell.lat, SEA_LEVEL, 100),
      },
    };
  });

  const world = emptyWorld(options.name || 'Новый мир');
  world.meta.schemaVersion = SCHEMA_VERSION;
  world.meta.seaLevel = SEA_LEVEL;
  world.meta.regionSource = 'cells';
  world.meta.source = 'blank';
  world.meta.description = `Пустая карта ${lonSpan}° x ${latSpan}°, ячеек ${features.length}`;
  world.cells = { type: 'FeatureCollection', features };
  world.layers.winds = { bands: [225, 45, 225, 315, 135, 315] };
  world.timeline.snapshots = [{ id: 'snap-start', date: '0', label: 'Начало', regionState: {} }];

  return world;
}
