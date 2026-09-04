import { acceptFiles, exportArchive, loadSampleWorld, restoreDraftIfAny, setImageOptionsAsker } from '../io/session';
import {
  DEFAULT_IMAGE_OPTIONS,
  isSvgFile,
  type ImageImportOptions,
  type ImageTarget,
  type RasterMode,
} from '../io/imageImport';
import { openForm } from './dialog';
import { pickFiles } from '../io/files';
import { debouncedDraftSaver } from '../io/draft';
import { MapView } from '../map/mapView';
import { renameWorld } from '../state/edits';
import { isWorldEmpty } from '../state/types';
import { setStatus, uiStore } from '../state/ui';
import { canRedo, canUndo, redo, redoLabel, setWorldChangeHook, undo, undoLabel, worldStore, onHistoryChange } from '../state/world';
import { TimelineView } from '../timeline/timelineView';
import { Inspector } from './inspector';
import { newMapDialog, Sidebar } from './sidebar';

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <header id="topbar">
      <div class="brand">Worldbuilder <span>Atlas</span></div>
      <input class="world-name" id="world-name" spellcheck="false" />
      <button id="undo" class="icon" title="Отменить (Ctrl+Z)">↶</button>
      <button id="redo" class="icon" title="Повторить (Ctrl+Shift+Z)">↷</button>
      <div class="spacer"></div>
      <div class="status" id="status"></div>
    </header>
    <div id="main">
      <aside id="sidebar"></aside>
      <div id="map-container">
        <div id="map-overlay">
          <button id="zoom-in" class="icon" title="Приблизить">+</button>
          <button id="zoom-out" class="icon" title="Отдалить">−</button>
          <button id="zoom-fit" class="icon" title="Вписать карту">⤢</button>
        </div>
        <div id="map-empty">
          <div class="card">
            <h2>Мир не загружен</h2>
            <p class="small muted">
              Импортируйте архив мира (.zip), полный JSON из Azgaar FMG
              (Export → JSON → Full), GIS-экспорт GeoJSON/CSV, картинку карты
              (SVG/PNG) — или откройте демонстрационный мир. Всё считается прямо
              в браузере, данные никуда не отправляются.
            </p>
            <div class="row wrap" style="justify-content:center;margin-top:12px">
              <button class="primary" id="empty-sample">Открыть демо-мир</button>
              <button id="empty-new">Новая карта…</button>
              <button id="empty-import">Импорт .zip</button>
              <button id="empty-azgaar">Импорт Azgaar</button>
              <button id="empty-image">Импорт картинки</button>
            </div>
          </div>
        </div>
      </div>
      <aside id="inspector"></aside>
    </div>
    <footer id="timeline"></footer>
  `;

  const mapContainer = root.querySelector<HTMLDivElement>('#map-container')!;
  const mapView = new MapView(mapContainer);
  new Sidebar(root.querySelector<HTMLElement>('#sidebar')!);
  new Inspector(root.querySelector<HTMLElement>('#inspector')!);
  new TimelineView(root.querySelector<HTMLElement>('#timeline')!);

  /* ---------- топбар ---------- */
  const nameInput = root.querySelector<HTMLInputElement>('#world-name')!;
  nameInput.addEventListener('change', () => renameWorld(nameInput.value.trim() || 'Без названия'));

  const undoButton = root.querySelector<HTMLButtonElement>('#undo')!;
  const redoButton = root.querySelector<HTMLButtonElement>('#redo')!;
  undoButton.addEventListener('click', () => undo());
  redoButton.addEventListener('click', () => redo());

  const syncHistoryButtons = (): void => {
    undoButton.disabled = !canUndo();
    redoButton.disabled = !canRedo();
    undoButton.title = canUndo() ? `Отменить: ${undoLabel()} (Ctrl+Z)` : 'Отменить (Ctrl+Z)';
    redoButton.title = canRedo() ? `Повторить: ${redoLabel()} (Ctrl+Shift+Z)` : 'Повторить (Ctrl+Shift+Z)';
  };
  onHistoryChange(syncHistoryButtons);
  syncHistoryButtons();

  const statusElement = root.querySelector<HTMLDivElement>('#status')!;
  uiStore.subscribe((state) => {
    statusElement.textContent = state.status;
  });

  /* ---------- пустое состояние ---------- */
  const emptyElement = root.querySelector<HTMLDivElement>('#map-empty')!;
  worldStore.subscribe((world) => {
    emptyElement.style.display = isWorldEmpty(world) ? 'grid' : 'none';
    if (document.activeElement !== nameInput) nameInput.value = world.meta.name;
  }, true);

  root.querySelector<HTMLButtonElement>('#empty-sample')!.addEventListener('click', () => loadSampleWorld());
  root.querySelector<HTMLButtonElement>('#empty-new')!.addEventListener('click', () => void newMapDialog());
  root.querySelector<HTMLButtonElement>('#empty-import')!.addEventListener('click', async () => {
    const files = await pickFiles('.zip,.json');
    if (files.length) await acceptFiles(files).catch(reportError);
  });
  root.querySelector<HTMLButtonElement>('#empty-azgaar')!.addEventListener('click', async () => {
    const files = await pickFiles('.geojson,.json,.csv', true);
    if (files.length) await acceptFiles(files).catch(reportError);
  });
  root.querySelector<HTMLButtonElement>('#empty-image')!.addEventListener('click', async () => {
    const files = await pickFiles('.svg,.png,.jpg,.jpeg,.webp');
    if (files.length) await acceptFiles(files).catch(reportError);
  });

  /* ---------- зум ---------- */
  root.querySelector<HTMLButtonElement>('#zoom-in')!.addEventListener('click', () => mapView.zoomBy(1.5));
  root.querySelector<HTMLButtonElement>('#zoom-out')!.addEventListener('click', () => mapView.zoomBy(1 / 1.5));
  root.querySelector<HTMLButtonElement>('#zoom-fit')!.addEventListener('click', () => mapView.fit());

  /* ---------- drag & drop ---------- */
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    mapContainer.classList.add('file-drop-active');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) mapContainer.classList.remove('file-drop-active');
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    mapContainer.classList.remove('file-drop-active');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) await acceptFiles(files).catch(reportError);
  });

  /* ---------- горячие клавиши ---------- */
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void exportArchive(false).catch(reportError);
      return;
    }
    if (typing) return;

    // инструменты и размер кисти
    const tools = {
      '1': 'select',
      '2': 'paint',
      '3': 'height',
      '4': 'points',
      '5': 'route',
      '6': 'vertices',
    } as const;
    const tool = tools[event.key as keyof typeof tools];
    if (tool) {
      uiStore.update((state) => {
        state.tool = tool;
      });
      setStatus(`Инструмент: ${tool}`, 1500);
      return;
    }
    if (event.key === '[' || event.key === ']') {
      uiStore.update((state) => {
        const delta = event.key === '[' ? -4 : 4;
        state.brush.size = Math.min(90, Math.max(4, state.brush.size + delta));
      });
      return;
    }
    // клавиши построения маршрута
    if (uiStore.get().tool === 'route' && mapView.hasRouteDraft()) {
      if (event.key === 'Enter') {
        event.preventDefault();
        mapView.finishRoute();
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        mapView.removeLastRouteWaypoint();
        return;
      }
      if (event.key === 'Escape') {
        mapView.cancelRoute();
        return;
      }
    }

    if (event.key === 'Escape') {
      uiStore.update((state) => {
        state.tool = 'select';
        state.selection = null;
      });
    }
  });

  /* ---------- настройки импорта картинки ---------- */
  setImageOptionsAsker(async (file) => {
    const vector = isSvgFile(file);
    const result = await openForm({
      title: vector ? `Импорт SVG: ${file.name}` : `Импорт картинки: ${file.name}`,
      submitLabel: 'Импортировать',
      fields: vector
        ? [
            {
              name: 'mode',
              label: 'Как разбирать SVG',
              type: 'select',
              value: 'colors',
              options: [
                { value: 'colors', label: 'По фигурам: каждая залитая фигура — регион' },
                { value: 'borders', label: 'По нарисованным границам: области между линиями' },
              ],
            },
            {
              name: 'target',
              label: 'Во что превратить найденное',
              type: 'select',
              value: 'states',
              options: [
                { value: 'states', label: 'Регионы и государства (по цвету)' },
                { value: 'zones', label: 'Зоны (только для разбора по фигурам)' },
                { value: 'cultures', label: 'Ареалы культур' },
                { value: 'religions', label: 'Ареалы религий' },
                { value: 'languages', label: 'Ареалы языков' },
              ],
            },
            {
              name: 'cells',
              label: 'Детализация для разбора по границам: число ячеек',
              type: 'number',
              value: '4000',
            },
          ]
        : [
            {
              name: 'mode',
              label: 'Как читать картинку',
              type: 'select',
              value: 'heightmap',
              options: [
                { value: 'heightmap', label: 'Рельеф по яркости (светлее — выше)' },
                { value: 'colors', label: 'Цветовые группы (заливки)' },
                { value: 'borders', label: 'По нарисованным границам (замкнутые области)' },
              ],
            },
            {
              name: 'target',
              label: 'Во что превратить области (для двух последних режимов)',
              type: 'select',
              value: 'states',
              options: [
                { value: 'states', label: 'Государства и регионы' },
                { value: 'cultures', label: 'Культуры' },
                { value: 'religions', label: 'Религии' },
                { value: 'languages', label: 'Языки' },
                { value: 'biomes', label: 'Биомы' },
              ],
            },
            { name: 'cells', label: 'Детализация: число ячеек', type: 'number', value: '4000' },
            { name: 'clusters', label: 'Цветовых групп искать (режим «цвета»)', type: 'number', value: '8' },
            {
              name: 'inkThreshold',
              label: 'Порог линий 0–100 (режим «границы»): больше — толще ловим',
              type: 'number',
              value: '40',
            },
            { name: 'invert', label: 'Инвертировать яркость (для рельефа): да/нет', value: 'нет' },
          ],
    });
    if (!result) return null;
    return {
      ...DEFAULT_IMAGE_OPTIONS,
      mode: (result.mode as RasterMode) ?? 'heightmap',
      target: (result.target as ImageTarget) ?? 'states',
      cells: Math.min(20000, Math.max(500, Number(result.cells) || DEFAULT_IMAGE_OPTIONS.cells)),
      clusters: Math.min(24, Math.max(2, Number(result.clusters) || DEFAULT_IMAGE_OPTIONS.clusters)),
      inkThreshold: Math.min(95, Math.max(5, Number(result.inkThreshold) || DEFAULT_IMAGE_OPTIONS.inkThreshold)),
      invert: /^(да|yes|true|1)$/i.test(result.invert ?? ''),
    } satisfies ImageImportOptions;
  });

  /* ---------- черновик ---------- */
  const saveDraft = debouncedDraftSaver(1500);
  let dirty = false;
  setWorldChangeHook((world) => {
    dirty = !isWorldEmpty(world);
    saveDraft(world);
  });
  window.addEventListener('world-exported', () => {
    dirty = false;
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  void restoreDraftIfAny().catch(() => undefined);
  setStatus('Готово. Перетащите архив мира или файлы Azgaar в окно.', 8000);
}

function reportError(error: unknown): void {
  console.error(error);
  setStatus(`Ошибка: ${(error as Error).message}`, 8000);
  window.alert(`Не получилось: ${(error as Error).message}`);
}
