import { Store } from './store';

export const LAYER_IDS = [
  'heightmap',
  'temperature',
  'precipitation',
  'winds',
  'currents',
  'biomes',
  'cultures',
  'religions',
  'languages',
  'states',
  'regionBorders',
  'zones',
  'rivers',
  'routes',
  'burgs',
  'markers',
  'mesh',
] as const;

export type LayerId = (typeof LAYER_IDS)[number];

/** Инструменты карты. */
export type ToolId = 'select' | 'paint' | 'height' | 'points' | 'route' | 'vertices';

/** Что ставит инструмент точек. */
export type PointKind = 'burg' | 'marker';

/** Что именно красит кисть. */
export type PaintTarget = 'biome' | 'cultureId' | 'religionId' | 'languageId' | 'regionId' | 'stateId';

/** Операции рельефа. */
export type HeightOp = 'up' | 'down' | 'flatten' | 'blend' | 'coastline';

export interface BrushState {
  target: PaintTarget;
  /** значение атрибута: имя биома или id культуры/религии/языка/региона/государства */
  value: string;
  /** радиус кисти в пикселях экрана */
  size: number;
  /** сила для операций рельефа */
  strength: number;
  heightOp: HeightOp;
}

export type SelectionKind = 'region' | 'cell' | 'burg' | 'marker' | 'state';

export interface Selection {
  kind: SelectionKind;
  id: string;
}

export interface UiState {
  layers: Record<LayerId, boolean>;
  tool: ToolId;
  brush: BrushState;
  /** инструмент точек: город или метка, и иконка для метки */
  point: { kind: PointKind; icon: string };
  /** инструмент маршрута: тип пути */
  routeGroup: 'roads' | 'trails' | 'searoutes';
  /** сглаживание растворённых границ (итерации Чайкина) */
  smoothing: number;
  /**
   * Правки географии (рельеф, биомы, культуры) пишутся не в базовую карту,
   * а в текущую эпоху: «с этой даты здесь залив/пустыня».
   */
  geoEpochEdit: boolean;
  /**
   * Правки политики и границ регионов действуют только с текущей эпохи.
   * По умолчанию включено: карта времени для того и нужна, чтобы прошлое
   * не менялось задним числом.
   */
  politicalEpochEdit: boolean;
  /** текущая позиция на шкале времени (числовое значение даты) */
  time: number;
  /** активный snapshot (последний на момент time), null если снапшотов нет */
  activeSnapshotId: string | null;
  /** state, которым «красим» регионы; null — режим покраски выключен */
  brushStateId: string | null;
  selection: Selection | null;
  selectedEventId: string | null;
  labels: boolean;
  status: string;
}

export function defaultUiState(): UiState {
  return {
    layers: {
      heightmap: false,
      temperature: false,
      precipitation: false,
      winds: false,
      currents: false,
      biomes: true,
      cultures: false,
      religions: false,
      languages: false,
      states: true,
      regionBorders: false,
      zones: false,
      rivers: true,
      routes: true,
      burgs: true,
      markers: true,
      mesh: false,
    },
    tool: 'select',
    brush: { target: 'stateId', value: '', size: 22, strength: 6, heightOp: 'up' },
    point: { kind: 'burg', icon: '◆' },
    routeGroup: 'roads',
    smoothing: 1,
    geoEpochEdit: false,
    politicalEpochEdit: true,
    time: 0,
    activeSnapshotId: null,
    brushStateId: null,
    selection: null,
    selectedEventId: null,
    labels: true,
    status: '',
  };
}

export const uiStore = new Store<UiState>(defaultUiState());

let statusTimer: number | undefined;

export function setStatus(text: string, holdMs = 4000): void {
  uiStore.update((s) => {
    s.status = text;
  });
  if (statusTimer) window.clearTimeout(statusTimer);
  if (holdMs > 0) {
    statusTimer = window.setTimeout(() => {
      uiStore.update((s) => {
        s.status = '';
      });
    }, holdMs);
  }
}
