/**
 * Черновик в IndexedDB: страховка от перезагрузки вкладки.
 * Это НЕ замена экспорту — данные всё равно живут только в браузере пользователя.
 */
import type { World } from '../state/types';

const DB_NAME = 'worldbuilder-atlas';
const STORE = 'drafts';
const KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export interface DraftRecord {
  savedAt: string;
  world: World;
}

export async function saveDraft(world: World): Promise<void> {
  const record: DraftRecord = { savedAt: new Date().toISOString(), world };
  try {
    await withStore('readwrite', (store) => store.put(record, KEY));
  } catch {
    // приватный режим / нет квоты — черновик просто недоступен
  }
}

export async function loadDraft(): Promise<DraftRecord | null> {
  try {
    const record = await withStore<DraftRecord | undefined>('readonly', (store) => store.get(KEY));
    return record ?? null;
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    /* ignore */
  }
}

/** Дебаунс-обёртка: пишем не чаще, чем раз в `delay` мс. */
export function debouncedDraftSaver(delay = 1500): (world: World) => void {
  let timer: number | undefined;
  return (world: World) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void saveDraft(world), delay);
  };
}
