/** Все правки мира проходят через эти функции — чтобы работали undo/redo и автосохранение черновика. */
import { CATEGORICAL } from '../map/colors';
import { uid } from '../util/id';
import { nameAt } from './naming';
import { cutEdgesIn, type CutEdgesOptions } from './paint';
import { simulateLandform, type LandformOptions } from '../sim/landform';
import { snapshotAt, sortedSnapshots, toNumericDate } from './time';
import type { Position } from 'geojson';
import type {
  Burg,
  ClimateSettings,
  DictEntry,
  MarkerPoint,
  NameChange,
  Snapshot,
  StateDef,
  Succession,
  TimelineEvent,
  World,
} from './types';
import { setStatus, uiStore } from './ui';
import { commit, mutateWorld, worldStore } from './world';

/** Snapshot, в который пишутся правки в момент времени `time`. Создаётся, только если снапшотов нет вовсе. */
function editableSnapshot(world: World, time: number): Snapshot {
  const existing = snapshotAt(world.timeline.snapshots, time);
  if (existing) return existing;
  const snapshot: Snapshot = {
    id: uid('snap'),
    date: String(Math.round(time)),
    label: 'Начальная эпоха',
    regionState: baselineOwnership(world),
  };
  world.timeline.snapshots.push(snapshot);
  return snapshot;
}

function baselineOwnership(world: World): Record<string, string> {
  const ownership: Record<string, string> = {};
  for (const feature of world.regions.features) {
    if (feature.properties.stateId) ownership[feature.properties.id] = feature.properties.stateId;
  }
  return ownership;
}

/* ---------------- регионы ---------------- */

export function assignRegionState(regionId: string, stateId: string | null): void {
  const time = uiStore.get().time;
  const world = worldStore.get();
  const stateName = world.timeline.states.find((state) => state.id === stateId)?.name ?? 'ничьё';
  commit(`Регион → ${stateName}`, (draft) => {
    const snapshot = editableSnapshot(draft, time);
    snapshot.regionState[regionId] = stateId ?? '';
  });
}

export function renameRegion(regionId: string, name: string): void {
  commit('Переименование региона', (draft) => {
    const feature = draft.regions.features.find((item) => item.properties.id === regionId);
    if (feature) feature.properties.name = name;
  });
}

/* ---------------- snapshots ---------------- */

export function addSnapshot(date: string, label?: string): string {
  const id = uid('snap');
  commit('Новая эпоха', (draft) => {
    const numeric = toNumericDate(date);
    const previous = snapshotAt(draft.timeline.snapshots, numeric);
    draft.timeline.snapshots.push({
      id,
      date,
      label: label || `Эпоха ${date}`,
      regionState: previous ? { ...previous.regionState } : baselineOwnership(draft),
    });
    draft.timeline.snapshots = sortedSnapshots(draft.timeline.snapshots);
  });
  setStatus(`Добавлена эпоха ${date} (скопирована с предыдущей)`);
  return id;
}

export function updateSnapshot(id: string, patch: Partial<Pick<Snapshot, 'date' | 'label' | 'notes'>>): void {
  commit('Правка эпохи', (draft) => {
    const snapshot = draft.timeline.snapshots.find((item) => item.id === id);
    if (!snapshot) return;
    Object.assign(snapshot, patch);
    draft.timeline.snapshots = sortedSnapshots(draft.timeline.snapshots);
  });
}

export function deleteSnapshot(id: string): void {
  commit('Удаление эпохи', (draft) => {
    draft.timeline.snapshots = draft.timeline.snapshots.filter((item) => item.id !== id);
  });
}

/** Убрать все гео-правки эпохи: география возвращается к базовой карте. */
export function clearGeoOverrides(snapshotId: string): void {
  commit('Сброс гео-правок эпохи', (draft) => {
    const snapshot = draft.timeline.snapshots.find((item) => item.id === snapshotId);
    if (snapshot) delete snapshot.geo;
  });
  setStatus('Гео-правки эпохи убраны');
}

/* ---------------- события ---------------- */

export function addEvent(event: Omit<TimelineEvent, 'id'>): string {
  const id = uid('ev');
  commit('Новое событие', (draft) => {
    draft.timeline.events.push({ id, ...event });
  });
  return id;
}

export function updateEvent(id: string, patch: Partial<TimelineEvent>): void {
  commit('Правка события', (draft) => {
    const event = draft.timeline.events.find((item) => item.id === id);
    if (event) Object.assign(event, patch);
  });
}

export function deleteEvent(id: string): void {
  commit('Удаление события', (draft) => {
    draft.timeline.events = draft.timeline.events.filter((item) => item.id !== id);
  });
}

/* ---------------- государства ---------------- */

export function addState(name?: string): string {
  const id = uid('state');
  commit('Новое государство', (draft) => {
    const index = draft.timeline.states.length;
    draft.timeline.states.push({
      id,
      name: name || `Государство ${index + 1}`,
      color: CATEGORICAL[index % CATEGORICAL.length],
    });
  });
  return id;
}

export function updateState(id: string, patch: Partial<StateDef>): void {
  commit('Правка государства', (draft) => {
    const state = draft.timeline.states.find((item) => item.id === id);
    if (state) Object.assign(state, patch);
  });
}

export function deleteState(id: string): void {
  commit('Удаление государства', (draft) => {
    draft.timeline.states = draft.timeline.states.filter((item) => item.id !== id);
    for (const snapshot of draft.timeline.snapshots) {
      for (const [regionId, stateId] of Object.entries(snapshot.regionState)) {
        if (stateId === id) snapshot.regionState[regionId] = '';
      }
    }
    for (const feature of draft.regions.features) {
      if (feature.properties.stateId === id) feature.properties.stateId = undefined;
    }
  });
}

/* ---------------- регионы и справочники ---------------- */

export type DictKind = 'cultures' | 'religions' | 'languages' | 'biomes';

/** Новый регион: пустой, наполняется кистью «Регион». */
export function addRegion(name?: string): string {
  const id = uid('region');
  commit('Новый регион', (draft) => {
    draft.regions.features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [] },
      properties: { id, name: name || `Регион ${draft.regions.features.length + 1}` },
    });
  });
  return id;
}

export function deleteRegion(id: string): void {
  commit('Удаление региона', (draft) => {
    draft.regions.features = draft.regions.features.filter((feature) => feature.properties.id !== id);
    for (const snapshot of draft.timeline.snapshots) delete snapshot.regionState[id];
    for (const feature of draft.cells.features) {
      if (feature.properties.regionId === id) delete feature.properties.regionId;
    }
  });
}

export function addDictEntry(kind: DictKind, name: string, color?: string): string {
  const prefix = kind === 'cultures' ? 'culture' : kind === 'religions' ? 'religion' : kind === 'languages' ? 'language' : 'biome';
  const id = uid(prefix);
  commit(`Новая запись: ${name}`, (draft) => {
    const entry: DictEntry = { id, name, color };
    draft.dictionaries[kind].push(entry);
  });
  return id;
}

export function updateDictEntry(kind: DictKind, id: string, patch: Partial<DictEntry>): void {
  commit('Правка справочника', (draft) => {
    const entry = draft.dictionaries[kind].find((item) => item.id === id);
    if (entry) Object.assign(entry, patch);
  });
}

/* ---------------- единый доступ к именам ---------------- */

/** Сущности, у которых есть имя и которые можно править «на всю карту». */
export type EntityKind = 'states' | 'regions' | 'cultures' | 'religions' | 'languages' | 'burgs' | 'markers';

export interface NamedEntity {
  id: string;
  name: string;
  color?: string;
  names?: NameChange[];
  succeededBy?: Succession[];
  note?: string;
}

/** Список сущностей вида `kind` в удобном для UI виде. */
export function listEntities(world: World, kind: EntityKind): NamedEntity[] {
  switch (kind) {
    case 'states':
      return world.timeline.states.map((state) => ({ ...state }));
    case 'regions':
      return world.regions.features.map((feature) => ({
        id: feature.properties.id,
        name: feature.properties.name ?? feature.properties.id,
        names: feature.properties.names,
      }));
    case 'cultures':
    case 'religions':
    case 'languages':
      return world.dictionaries[kind].map((entry) => ({ ...entry }));
    case 'burgs':
      return world.points.burgs.map((burg) => ({
        id: burg.id,
        name: burg.name,
        names: burg.names,
        note: burg.note,
      }));
    case 'markers':
      return world.points.markers.map((marker) => ({
        id: marker.id,
        name: marker.name,
        names: marker.names,
        note: marker.note,
      }));
  }
}

/** Применить изменение к сущности внутри переданного мира. */
function withEntity(world: World, kind: EntityKind, id: string, apply: (entity: Record<string, unknown>) => void): void {
  switch (kind) {
    case 'states': {
      const state = world.timeline.states.find((item) => item.id === id);
      if (state) apply(state as unknown as Record<string, unknown>);
      return;
    }
    case 'regions': {
      const feature = world.regions.features.find((item) => item.properties.id === id);
      if (feature) apply(feature.properties as unknown as Record<string, unknown>);
      return;
    }
    case 'cultures':
    case 'religions':
    case 'languages': {
      const entry = world.dictionaries[kind].find((item) => item.id === id);
      if (entry) apply(entry as unknown as Record<string, unknown>);
      return;
    }
    case 'burgs': {
      const burg = world.points.burgs.find((item) => item.id === id);
      if (burg) apply(burg as unknown as Record<string, unknown>);
      return;
    }
    case 'markers': {
      const marker = world.points.markers.find((item) => item.id === id);
      if (marker) apply(marker as unknown as Record<string, unknown>);
      return;
    }
  }
}

export function renameEntity(kind: EntityKind, id: string, name: string): void {
  commit(`Переименование: ${name}`, (draft) => {
    withEntity(draft, kind, id, (entity) => {
      entity.name = name;
    });
  });
}

export function setEntityColor(kind: EntityKind, id: string, color: string): void {
  commit('Смена цвета', (draft) => {
    withEntity(draft, kind, id, (entity) => {
      entity.color = color;
    });
  });
}

/** История переименований: с какой даты сущность зовётся иначе. */
export function setNameHistory(kind: EntityKind, id: string, changes: NameChange[]): void {
  commit('Правка переименований', (draft) => {
    withEntity(draft, kind, id, (entity) => {
      if (changes.length === 0) delete entity.names;
      else entity.names = [...changes].sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));
    });
  });
}

/** Переходы: во что и с какой даты превращается сущность. */
export function setSuccessions(kind: EntityKind, id: string, list: Succession[]): void {
  commit('Правка переходов', (draft) => {
    withEntity(draft, kind, id, (entity) => {
      if (list.length === 0) delete entity.succeededBy;
      else entity.succeededBy = [...list].sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));
    });
  });
}

/** Массовая замена в именах — включая исторические. Возвращает число правок. */
export function replaceInNames(kind: EntityKind, search: string, replacement: string): number {
  if (!search) return 0;
  let count = 0;
  commit(`Замена «${search}» → «${replacement}»`, (draft) => {
    for (const entity of listEntities(draft, kind)) {
      withEntity(draft, kind, entity.id, (target) => {
        const name = String(target.name ?? '');
        if (name.includes(search)) {
          target.name = name.split(search).join(replacement);
          count += 1;
        }
        const names = target.names as NameChange[] | undefined;
        if (names) {
          for (const change of names) {
            if (change.name.includes(search)) {
              change.name = change.name.split(search).join(replacement);
              count += 1;
            }
          }
        }
      });
    }
  });
  setStatus(count > 0 ? `Заменено вхождений: ${count}` : 'Совпадений не найдено');
  return count;
}

/* ---------------- климат мира ---------------- */

/**
 * Настройки климата: где проходит экватор и какие температуры на экваторе и
 * полюсе. Влияют и на симуляцию, и на отрисовку ветров.
 */
export function updateClimateSettings(patch: ClimateSettings): void {
  commit('Настройка климата', (draft) => {
    draft.meta.climate = { ...draft.meta.climate, ...patch };
  });
}

/* ---------------- города, метки, маршруты ---------------- */

export function addBurg(x: number, y: number, name?: string, from?: string): string {
  const id = uid('burg');
  commit('Новый город', (draft) => {
    draft.points.burgs.push({
      id,
      name: name || `Город ${draft.points.burgs.length + 1}`,
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
      population: 5,
      from,
    });
  });
  return id;
}

export function updateBurg(id: string, patch: Partial<Burg>): void {
  commit('Правка города', (draft) => {
    const burg = draft.points.burgs.find((item) => item.id === id);
    if (burg) Object.assign(burg, patch);
  });
}

export function deleteBurg(id: string): void {
  commit('Удаление города', (draft) => {
    draft.points.burgs = draft.points.burgs.filter((item) => item.id !== id);
  });
}

export function addMarker(x: number, y: number, icon?: string, name?: string, from?: string): string {
  const id = uid('marker');
  commit('Новая метка', (draft) => {
    draft.points.markers.push({
      id,
      name: name || `Метка ${draft.points.markers.length + 1}`,
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
      icon: icon || '◆',
      from,
    });
  });
  return id;
}

export function updateMarker(id: string, patch: Partial<MarkerPoint>): void {
  commit('Правка метки', (draft) => {
    const marker = draft.points.markers.find((item) => item.id === id);
    if (marker) Object.assign(marker, patch);
  });
}

export function deleteMarker(id: string): void {
  commit('Удаление метки', (draft) => {
    draft.points.markers = draft.points.markers.filter((item) => item.id !== id);
  });
}

/** Перенос точки без записи в историю на каждый кадр — вызывается внутри мазка. */
export function movePoint(kind: 'burg' | 'marker', id: string, x: number, y: number): void {
  mutateWorld((world) => {
    const list = kind === 'burg' ? world.points.burgs : world.points.markers;
    const point = list.find((item) => item.id === id);
    if (!point) return;
    point.x = Math.round(x * 1000) / 1000;
    point.y = Math.round(y * 1000) / 1000;
  });
}

export function addRoute(points: Position[], group: string, name?: string): string {
  const id = uid('route');
  commit('Новый маршрут', (draft) => {
    const collection = draft.layers.routes ?? { type: 'FeatureCollection', features: [] };
    collection.features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points },
      properties: {
        id,
        group,
        name: name || `${group === 'searoutes' ? 'Морской путь' : group === 'trails' ? 'Тропа' : 'Дорога'} ${collection.features.length + 1}`,
      },
    });
    draft.layers.routes = collection;
  });
  return id;
}

export function updateRoute(id: string, patch: { name?: string; group?: string }): void {
  commit('Правка маршрута', (draft) => {
    const feature = draft.layers.routes?.features.find((item) => item.properties.id === id);
    if (feature) Object.assign(feature.properties, patch);
  });
}

export function deleteRoute(id: string): void {
  commit('Удаление маршрута', (draft) => {
    if (!draft.layers.routes) return;
    draft.layers.routes.features = draft.layers.routes.features.filter(
      (item) => item.properties.id !== id,
    );
  });
}

/* ---------------- массовая очистка ---------------- */

/**
 * Удалить все государства. Регионы и ячейки остаются, но становятся ничьими
 * во всех эпохах — политическая карта обнуляется, география цела.
 */
export function clearAllStates(): number {
  const count = worldStore.get().timeline.states.length;
  if (count === 0) return 0;
  commit('Очистка государств', (draft) => {
    draft.timeline.states = [];
    for (const snapshot of draft.timeline.snapshots) snapshot.regionState = {};
    for (const feature of draft.regions.features) delete feature.properties.stateId;
    for (const feature of draft.cells.features) delete feature.properties.stateId;
  });
  setStatus(`Удалено государств: ${count}. Регионы остались, но стали ничьими`);
  return count;
}

/**
 * Удалить все регионы. Ячейки теряют принадлежность региону — и базовую,
 * и эпохальные оверрайды, — а вместе с ней и политику.
 */
export function clearAllRegions(): number {
  const count = worldStore.get().regions.features.length;
  if (count === 0) return 0;
  commit('Очистка регионов', (draft) => {
    draft.regions.features = [];
    for (const feature of draft.cells.features) delete feature.properties.regionId;
    for (const snapshot of draft.timeline.snapshots) {
      snapshot.regionState = {};
      if (!snapshot.geo) continue;
      for (const [cellId, patch] of Object.entries(snapshot.geo)) {
        if (patch.regionId === undefined) continue;
        delete patch.regionId;
        if (Object.keys(patch).length === 0) delete snapshot.geo[cellId];
      }
    }
  });
  setStatus(`Удалено регионов: ${count}. Ячейки остались без региона`);
  return count;
}

/* ---------------- регион <-> государство ---------------- */

/**
 * Регион с именем государства: удобно, когда государство есть, а территории
 * под него ещё нет. Регион сразу закрепляется за этим государством в текущей
 * эпохе — остаётся закрасить его кистью.
 */
export function createRegionFromState(stateId: string, time: number): string | null {
  const world = worldStore.get();
  const state = world.timeline.states.find((item) => item.id === stateId);
  if (!state) return null;
  const id = uid('region');
  const name = nameAt(state, time);
  commit(`Регион «${name}» из государства`, (draft) => {
    draft.regions.features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [] },
      properties: { id, name, stateId },
    });
    const snapshot = snapshotAt(draft.timeline.snapshots, time);
    if (snapshot) snapshot.regionState[id] = stateId;
  });
  setStatus(`Создан регион «${name}» — закрасьте его кистью региона`);
  return id;
}

/**
 * Государство с именем региона и владение этим регионом в текущей эпохе.
 * Обратная операция к предыдущей: удобно превращать землю в державу.
 */
export function createStateFromRegion(regionId: string, time: number): string | null {
  const world = worldStore.get();
  const feature = world.regions.features.find((item) => item.properties.id === regionId);
  if (!feature) return null;
  const id = uid('state');
  const name = nameAt(
    { id: regionId, name: feature.properties.name, names: feature.properties.names },
    time,
  );
  commit(`Государство «${name}» из региона`, (draft) => {
    const index = draft.timeline.states.length;
    draft.timeline.states.push({ id, name, color: CATEGORICAL[index % CATEGORICAL.length] });
    const snapshot = snapshotAt(draft.timeline.snapshots, time);
    if (snapshot) snapshot.regionState[regionId] = id;
    const target = draft.regions.features.find((item) => item.properties.id === regionId);
    if (target && !target.properties.stateId) target.properties.stateId = id;
  });
  setStatus(`Создано государство «${name}», регион закреплён за ним в текущей эпохе`);
  return id;
}

/* ---------------- ветра ---------------- */

/** Направления широтных полос ветра. От них зависят осадки и течения. */
export function updateWindBands(bands: number[]): void {
  commit('Настройка ветров', (draft) => {
    const normalized = bands.map((angle) => ((Math.round(angle) % 360) + 360) % 360);
    draft.layers.winds = { ...draft.layers.winds, bands: normalized, vectors: undefined };
  });
}

/** Отказаться от явных векторов ветра в пользу широтных полос. */
export function dropWindVectors(): void {
  commit('Ветра: перейти на полосы', (draft) => {
    const bands = draft.layers.winds?.bands ?? [225, 45, 225, 315, 135, 315];
    draft.layers.winds = { bands };
  });
  setStatus('Ветра переведены на широтные полосы');
}

/* ---------------- симуляция ландшафта ---------------- */

/** Прогнать симуляцию ландшафта: одна запись в истории, отменяется целиком. */
export function runLandformSimulation(options: LandformOptions): string[] {
  let log: string[] = [];
  commit('Симуляция ландшафта', (draft) => {
    log = simulateLandform(draft, options);
  });
  console.info('[worldbuilder-atlas] симуляция ландшафта:\n' + log.join('\n'));
  setStatus(log[log.length - 1] ?? 'Симуляция завершена', 8000);
  return log;
}

/* ---------------- обрезка краёв ---------------- */

/**
 * Убрать из политических территорий торчащие ячейки и закрашенную воду
 * в текущей эпохе. Одна запись в истории.
 */
export function cutPoliticalEdges(time: number, options: Partial<CutEdgesOptions> = {}): number {
  let released = 0;
  commit('Обрезка краёв', (draft) => {
    released = cutEdgesIn(draft, { time, ...options });
  });
  setStatus(
    released > 0 ? `Обрезано ячеек: ${released}` : 'Нечего обрезать — края и так чистые',
  );
  return released;
}

/* ---------------- прочее ---------------- */

export function renameWorld(name: string): void {
  commit('Переименование мира', (draft) => {
    draft.meta.name = name;
  });
}

export function updateMarkerNote(markerId: string, note: string): void {
  commit('Правка метки', (draft) => {
    const marker = draft.points.markers.find((item) => item.id === markerId);
    if (marker) marker.note = note;
  });
}
