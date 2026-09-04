/**
 * Поиск пути по сетке ячеек (A*).
 *
 * Нужен для маршрутов: пользователь ставит опорные точки, а дорога сама
 * прокладывается между ними по ячейкам — обходит горы, держится суши (или
 * наоборот воды для морских путей). Ручное протыкивание каждой ячейки было бы
 * мучением, а прямая линия игнорировала бы рельеф.
 */
import type { World } from '../state/types';
import { topologyOf } from '../state/topology';

export type RouteMode = 'land' | 'sea' | 'any';

export interface PathOptions {
  mode: RouteMode;
  /** уровень моря, чтобы отличать сушу от воды */
  seaLevel: number;
}

/** Минимальная куча для очереди A*. */
class Heap {
  private keys: number[] = [];
  private values: string[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: string): void {
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

  pop(): string | null {
    if (this.keys.length === 0) return null;
    const top = this.values[0];
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
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
}

/**
 * Путь между ячейками. Возвращает список id ячеек включая концы либо null,
 * если пройти нельзя (например, морской путь через материк).
 */
export function findPath(
  world: World,
  fromId: string,
  toId: string,
  options: PathOptions,
): string[] | null {
  const topology = topologyOf(world);
  if (!topology.byId.has(fromId) || !topology.byId.has(toId)) return null;
  if (fromId === toId) return [fromId];

  const heightOf = (id: string): number => Number(topology.byId.get(id)?.properties.height ?? 0);
  const isWater = (id: string): boolean => heightOf(id) < options.seaLevel;

  /** Во сколько раз ячейка «дороже» обычной. Infinity — непроходима. */
  const terrainCost = (id: string): number => {
    const water = isWater(id);
    if (options.mode === 'sea') return water ? 1 : Infinity;
    if (options.mode === 'land') {
      // воду не запрещаем совсем: узкий пролив дорога может пересечь паромом,
      // но обход по суше почти всегда окажется дешевле
      if (water) return 9;
      const height = heightOf(id);
      const climb = Math.max(0, height - options.seaLevel) / 100;
      return 1 + climb * 2.5;
    }
    return 1;
  };

  const distance = (a: string, b: string): number => {
    const pa = topology.pointById.get(a);
    const pb = topology.pointById.get(b);
    if (!pa || !pb) return 1;
    return Math.hypot(pa.lon - pb.lon, pa.lat - pb.lat);
  };

  const target = topology.pointById.get(toId);
  const heuristic = (id: string): number => {
    const point = topology.pointById.get(id);
    if (!point || !target) return 0;
    return Math.hypot(point.lon - target.lon, point.lat - target.lat);
  };

  const cameFrom = new Map<string, string>();
  const best = new Map<string, number>([[fromId, 0]]);
  const queue = new Heap();
  queue.push(heuristic(fromId), fromId);
  const visited = new Set<string>();
  // потолок на всякий случай: на больших мирах поиск не должен вешать вкладку
  let steps = 0;
  const limit = Math.max(20000, topology.cells.length * 4);

  while (queue.size > 0 && steps++ < limit) {
    const current = queue.pop()!;
    if (current === toId) break;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const next of topology.neighbors.get(current) ?? []) {
      const cost = terrainCost(next);
      if (!Number.isFinite(cost)) continue;
      const tentative = (best.get(current) ?? Infinity) + distance(current, next) * cost;
      if (tentative >= (best.get(next) ?? Infinity)) continue;
      best.set(next, tentative);
      cameFrom.set(next, current);
      queue.push(tentative + heuristic(next), next);
    }
  }

  if (!cameFrom.has(toId) && fromId !== toId) return null;

  const path: string[] = [toId];
  let cursor = toId;
  while (cursor !== fromId) {
    const previous = cameFrom.get(cursor);
    if (!previous) return null;
    path.push(previous);
    cursor = previous;
  }
  return path.reverse();
}
