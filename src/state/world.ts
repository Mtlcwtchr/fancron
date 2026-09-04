import { Store } from './store';
import { emptyWorld, type World } from './types';
import { snapshotAt, toNumericDate } from './time';
import { uiStore } from './ui';

export const worldStore = new Store<World>(emptyWorld());

/**
 * Ревизии для инвалидации тяжёлых кэшей (растворённые границы, соседство ячеек).
 *
 * `generation` — полная инвалидация (импорт, undo, конец правки). `partial` — точечная:
 * мазок кистью культур не должен пересчитывать биомы и политику, иначе каждый кадр
 * рисования упирается в растворение всех слоёв.
 */
let generation = 1;
const partial = new Map<string, number>();

export function worldRevision(): number {
  return generation * 1_000_000 + partial.size;
}

/** Ревизия конкретного слоя данных: 'biomes' | 'cultures' | 'states' | 'regions' | 'heightmap' … */
export function layerRevision(key: string): number {
  return generation * 1_000_000 + (partial.get(key) ?? 0);
}

function invalidateAll(): void {
  generation += 1;
  partial.clear();
}

/* ------------------------------------------------------------------ */
/* undo / redo                                                         */
/* ------------------------------------------------------------------ */

interface HistoryEntry {
  label: string;
  world: World;
}

const UNDO_LIMIT = 40;
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
const historyListeners = new Set<() => void>();

export function onHistoryChange(listener: () => void): () => void {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

function notifyHistory(): void {
  for (const listener of historyListeners) listener();
}

function clone(world: World): World {
  return structuredClone(world);
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}
export function undoLabel(): string | null {
  return undoStack.at(-1)?.label ?? null;
}
export function redoLabel(): string | null {
  return redoStack.at(-1)?.label ?? null;
}

let onWorldChanged: ((world: World) => void) | null = null;

/** Хук, вызываемый после каждой правки (используется для черновика в IndexedDB). */
export function setWorldChangeHook(hook: (world: World) => void): void {
  onWorldChanged = hook;
}

/** Единственная точка изменения мира: пишет историю, обновляет updatedAt, шлёт события. */
export function commit(label: string, mutate: (world: World) => void): void {
  const current = worldStore.get();
  pushUndo(label, current);
  mutate(current);
  finishChange(current);
}

function pushUndo(label: string, world: World): void {
  undoStack.push({ label, world: clone(world) });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function finishChange(world: World): void {
  world.meta.updatedAt = new Date().toISOString();
  invalidateAll();
  worldStore.touch();
  notifyHistory();
  onWorldChanged?.(world);
}

/* ------------------------------------------------------------------ */
/* мазки кистью: одна запись в истории на весь мазок                   */
/* ------------------------------------------------------------------ */

let strokeActive = false;

/** Начало мазка: снимок для undo делается один раз, до первого изменения. */
export function beginStroke(label: string): void {
  if (strokeActive) return;
  strokeActive = true;
  pushUndo(label, worldStore.get());
}

/**
 * Изменение внутри мазка: без записи в историю, но с перерисовкой.
 * `affects` перечисляет затронутые слои данных — незатронутые кэши остаются валидными.
 */
export function mutateWorld(mutate: (world: World) => void, affects?: string[]): void {
  const current = worldStore.get();
  mutate(current);
  if (affects && affects.length > 0) {
    for (const key of affects) partial.set(key, (partial.get(key) ?? 0) + 1);
  } else {
    invalidateAll();
  }
  worldStore.touch();
}

/** Конец мазка: фиксируем время правки, черновик и состояние кнопок undo/redo. */
export function endStroke(): void {
  if (!strokeActive) return;
  strokeActive = false;
  finishChange(worldStore.get());
}

export function isStrokeActive(): boolean {
  return strokeActive;
}

/** Полная замена мира (импорт). История сбрасывается. */
export function replaceWorld(world: World, resetHistory = true): void {
  if (resetHistory) {
    undoStack.length = 0;
    redoStack.length = 0;
  }
  worldStore.set(world);
  invalidateAll();
  notifyHistory();
  onWorldChanged?.(world);
}

export function undo(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  redoStack.push({ label: entry.label, world: clone(worldStore.get()) });
  worldStore.set(entry.world);
  invalidateAll();
  notifyHistory();
  onWorldChanged?.(entry.world);
}

export function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  undoStack.push({ label: entry.label, world: clone(worldStore.get()) });
  worldStore.set(entry.world);
  invalidateAll();
  notifyHistory();
  onWorldChanged?.(entry.world);
}

/* ------------------------------------------------------------------ */
/* селекторы                                                           */
/* ------------------------------------------------------------------ */

/**
 * Государство, владеющее регионом в момент времени.
 * Ищем в активном snapshot'е, затем в более ранних, затем — базовая принадлежность.
 */
export function stateIdForRegionAt(world: World, regionId: string, time: number): string | undefined {
  const sorted = [...world.timeline.snapshots].sort(
    (a, b) => toNumericDate(a.date) - toNumericDate(b.date),
  );
  const active = snapshotAt(world.timeline.snapshots, time);
  if (active) {
    const index = sorted.findIndex((s) => s.id === active.id);
    for (let i = index; i >= 0; i--) {
      const owner = sorted[i].regionState[regionId];
      if (owner !== undefined) return owner || undefined;
    }
  }
  const feature = world.regions.features.find((f) => f.properties.id === regionId);
  return feature?.properties.stateId;
}

/** Карта regionId -> stateId на момент времени (один проход, для отрисовки). */
export function regionOwnershipAt(world: World, time: number): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  for (const feature of world.regions.features) {
    result.set(feature.properties.id, feature.properties.stateId);
  }
  const sorted = [...world.timeline.snapshots].sort(
    (a, b) => toNumericDate(a.date) - toNumericDate(b.date),
  );
  const active = snapshotAt(world.timeline.snapshots, time);
  if (!active) return result;
  const upto = sorted.findIndex((s) => s.id === active.id);
  for (let i = 0; i <= upto; i++) {
    for (const [regionId, stateId] of Object.entries(sorted[i].regionState)) {
      result.set(regionId, stateId || undefined);
    }
  }
  return result;
}

export function stateById(world: World, id: string | undefined): World['timeline']['states'][number] | undefined {
  if (!id) return undefined;
  return world.timeline.states.find((s) => s.id === id);
}

export function activeSnapshot(world: World, time?: number): ReturnType<typeof snapshotAt> {
  const t = time ?? uiStore.get().time;
  return snapshotAt(world.timeline.snapshots, t);
}
