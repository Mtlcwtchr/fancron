/** Действия уровня приложения: загрузить/сохранить мир, импортировать Azgaar, поднять черновик. */
import { createSampleWorld } from '../sample/sampleWorld';
import { createBlankWorld, type BlankWorldOptions } from '../sample/newWorld';
import { sortedSnapshots, toNumericDate } from '../state/time';
import { emptyWorld, type World } from '../state/types';
import { setStatus, uiStore } from '../state/ui';
import { replaceWorld, worldStore } from '../state/world';
import { importAzgaarFiles } from './azgaar';
import { importFmgFull, isFmgFullJson } from './fmgFull';
import {
  DEFAULT_IMAGE_OPTIONS,
  importRasterImage,
  importSvgMap,
  isImageFile,
  isSvgFile,
  type ImageImportOptions,
} from './imageImport';
import { exportWorldZip, importWorldJson, importWorldZip } from './archive';
import { normalizeWorld } from './validate';
import { clearDraft, loadDraft } from './draft';
import { downloadBlob, hasFileSystemAccess, saveToDisk } from './files';

function afterLoad(world: World, message: string): void {
  replaceWorld(world);
  const first = sortedSnapshots(world.timeline.snapshots)[0];
  uiStore.update((state) => {
    state.selection = null;
    state.selectedEventId = null;
    state.brushStateId = null;
    state.time = first ? toNumericDate(first.date) : 0;
    state.activeSnapshotId = first?.id ?? null;
  });
  setStatus(message, 6000);
}

/**
 * UI подставляет сюда диалог настроек импорта картинки: слой io не должен
 * сам открывать окна, а спрашивать пользователя всё равно надо.
 */
export type ImageOptionsAsker = (file: File) => Promise<ImageImportOptions | null>;

let imageOptionsAsker: ImageOptionsAsker | null = null;

export function setImageOptionsAsker(asker: ImageOptionsAsker): void {
  imageOptionsAsker = asker;
}

async function importImage(file: File): Promise<void> {
  const options = imageOptionsAsker ? await imageOptionsAsker(file) : DEFAULT_IMAGE_OPTIONS;
  if (!options) return;
  const { world, log } = isSvgFile(file)
    ? await importSvgMap(file, options)
    : await importRasterImage(file, options);
  console.info('[worldbuilder-atlas] импорт картинки:\n' + log.join('\n'));
  afterLoad(normalizeWorld(world), `Мир собран из ${file.name}: ${log[log.length - 1] ?? ''}`);
}

export function loadSampleWorld(): void {
  afterLoad(normalizeWorld(createSampleWorld()), 'Загружен демо-мир. Двигайте ползунок времени внизу.');
}

export function loadEmptyWorld(): void {
  afterLoad(emptyWorld(), 'Создан пустой мир. Импортируйте данные Azgaar или архив.');
}

/** Пустая карта заданного размера, уже с сеткой ячеек — можно сразу рисовать. */
export function createBlank(options: BlankWorldOptions): void {
  const world = normalizeWorld(createBlankWorld(options));
  afterLoad(
    world,
    `Создана карта ${options.lonSpan}° x ${options.latSpan}°, ячеек ${world.cells.features.length}. ` +
      'Рельеф — инструментом «Рельеф», границы — кистью.',
  );
}

export async function importArchiveFile(file: File): Promise<void> {
  const world = file.name.toLowerCase().endsWith('.json')
    ? importWorldJson(await file.text())
    : await importWorldZip(file);
  afterLoad(world, `Мир «${world.meta.name}» загружен из ${file.name}`);
}

export async function importAzgaar(files: File[]): Promise<string[]> {
  const { world, log } = await importAzgaarFiles(files);
  afterLoad(world, `Импортировано из Azgaar: ${files.length} файл(ов)`);
  return log;
}

/**
 * Приём произвольного набора файлов (кнопка или drag&drop). Порядок распознавания:
 *  0. .svg / .png / .jpg — картинка карты (разбор в мир, см. imageImport.ts);
 *  1. .zip — архив мира;
 *  2. .json с pack.cells — полный экспорт Azgaar FMG (Export -> JSON -> Full);
 *  3. .json с meta/timeline — дамп внутренней модели;
 *  4. остальное — GIS-экспорт Azgaar (GeoJSON) и CSV-таблицы.
 */
export async function acceptFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;

  const archive = files.find((file) => file.name.toLowerCase().endsWith('.zip'));
  if (archive) {
    await importArchiveFile(archive);
    return;
  }

  const picture = files.find((file) => isSvgFile(file) || isImageFile(file));
  if (picture) {
    await importImage(picture);
    return;
  }

  const native = files.find((file) => file.name.toLowerCase().endsWith('.map'));
  if (native) {
    throw new Error(
      `${native.name}: формат .map (родное сохранение FMG) не читается. ` +
        'В Azgaar: Export -> JSON -> Full, либо Export -> GIS data (GeoJSON) — оба формата поддерживаются.',
    );
  }

  const jsonFiles = files.filter((file) => /\.(json|geojson)$/i.test(file.name));
  const others = files.filter((file) => !/\.(json|geojson)$/i.test(file.name));

  // .json может быть и полным дампом FMG, и нашим архивом-дампом, и GIS-слоем
  for (const file of jsonFiles) {
    if (file.name.toLowerCase().endsWith('.geojson')) continue;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file.name}: невалидный JSON (${(error as Error).message})`);
    }
    if (isFmgFullJson(parsed)) {
      const { world, log } = importFmgFull(parsed);
      console.info('[worldbuilder-atlas] импорт полного JSON Azgaar:\n' + log.join('\n'));
      afterLoad(normalizeWorld(world), `Мир «${world.meta.name}» импортирован из полного JSON Azgaar`);
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.meta || record.timeline || (record.cells && record.type !== 'FeatureCollection')) {
      afterLoad(importWorldJson(text), `Мир загружен из ${file.name}`);
      return;
    }
  }

  const log = await importAzgaar([...jsonFiles, ...others]);
  console.info('[worldbuilder-atlas] импорт Azgaar:\n' + log.join('\n'));
}

function fileNameFor(world: World): string {
  const slug = world.meta.name.trim().replace(/\s+/g, '-').replace(/[^\w\-а-яё]/gi, '') || 'world';
  return `${slug}.zip`;
}

export async function exportArchive(saveAs = false): Promise<void> {
  const world = worldStore.get();
  const blob = await exportWorldZip(world);
  const name = fileNameFor(world);
  if (hasFileSystemAccess()) {
    try {
      const saved = await saveToDisk(blob, name, saveAs);
      if (saved) {
        setStatus(`Мир сохранён в файл (${(blob.size / 1024).toFixed(0)} КБ)`);
        window.dispatchEvent(new Event('world-exported'));
        return;
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      console.warn('File System Access недоступен, падаем в обычное скачивание', error);
    }
  }
  downloadBlob(blob, name);
  setStatus(`Архив ${name} скачан (${(blob.size / 1024).toFixed(0)} КБ)`);
  window.dispatchEvent(new Event('world-exported'));
}

export async function restoreDraftIfAny(): Promise<boolean> {
  const draft = await loadDraft();
  if (!draft?.world) return false;
  const saved = new Date(draft.savedAt);
  const ok = window.confirm(
    `Найден черновик мира «${draft.world.meta.name}» от ${saved.toLocaleString()}.\nВосстановить его?`,
  );
  if (!ok) {
    await clearDraft();
    return false;
  }
  afterLoad(draft.world, 'Черновик восстановлен из браузера');
  return true;
}
