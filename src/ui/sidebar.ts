import { acceptFiles, createBlank, exportArchive, loadSampleWorld } from '../io/session';
import { DEFAULT_BLANK_OPTIONS, type ReliefPreset } from '../sample/newWorld';
import { hasFileSystemAccess, pickFiles } from '../io/files';
import { AZGAAR_BIOMES, biomeColor, CATEGORICAL } from '../map/colors';
import { legendFor } from '../map/layers';
import { DEFAULT_LANDFORM_OPTIONS, type LandformOptions } from '../sim/landform';
import {
  addDictEntry,
  addRegion,
  addState,
  clearAllRegions,
  clearAllStates,
  clearGeoOverrides,
  cutPoliticalEdges,
  dropWindVectors,
  runLandformSimulation,
  updateClimateSettings,
  updateRoute,
  updateWindBands,
  deleteRegion,
  deleteRoute,
  deleteState,
  updateState,
  type DictKind,
} from '../state/edits';
import { countOverrides, regionCellCounts } from '../state/geoOverrides';
import { nameAt, pointVisibleAt } from '../state/naming';
import { snapshotAt } from '../state/time';
import { openNamesManager } from './namesManager';
import { LAYER_IDS, setStatus, uiStore, type HeightOp, type LayerId, type PaintTarget, type UiState } from '../state/ui';
import type { World } from '../state/types';
import { regionOwnershipAt, worldStore } from '../state/world';
import { confirmDialog, confirmModal, openForm } from './dialog';

const LAYER_LABELS: Record<LayerId, string> = {
  heightmap: 'Рельеф (heightmap)',
  temperature: 'Температура',
  precipitation: 'Осадки',
  winds: 'Ветра / климат',
  currents: 'Морские течения',
  biomes: 'Биомы',
  cultures: 'Культуры',
  religions: 'Религии',
  languages: 'Языки',
  states: 'Государства (политика)',
  regionBorders: 'Границы регионов',
  zones: 'Зоны (события)',
  rivers: 'Реки',
  routes: 'Дороги и пути',
  burgs: 'Города',
  markers: 'Метки',
  mesh: 'Сетка ячеек',
};

const LEGEND_LAYERS: LayerId[] = ['biomes', 'cultures', 'religions', 'languages', 'states', 'routes', 'zones'];

const PAINT_TARGETS: Array<{ id: PaintTarget; label: string }> = [
  { id: 'stateId', label: 'Государство' },
  { id: 'regionId', label: 'Регион' },
  { id: 'biome', label: 'Биом' },
  { id: 'cultureId', label: 'Культура' },
  { id: 'religionId', label: 'Религия' },
  { id: 'languageId', label: 'Язык' },
];

const HEIGHT_OPS: Array<{ id: HeightOp; label: string; hint: string }> = [
  { id: 'up', label: 'Поднять', hint: 'Поднимает высоту ячеек под кистью' },
  { id: 'down', label: 'Опустить', hint: 'Опускает высоту ячеек под кистью' },
  { id: 'flatten', label: 'Выровнять', hint: 'Тянет высоты к средней под кистью' },
  { id: 'blend', label: 'Размыть', hint: 'Усредняет высоту по соседним ячейкам' },
  { id: 'coastline', label: 'Берег', hint: 'Чистит береговую линию: убирает одинокие острова и лагуны' },
];

function layerCount(world: World, id: LayerId, time: number): number {
  switch (id) {
    case 'heightmap':
      return world.layers.heightmap ? world.layers.heightmap.values.length : world.cells.features.length;
    case 'winds':
      return world.layers.winds?.vectors?.length ?? world.layers.winds?.bands?.length ?? 0;
    case 'currents':
      return world.layers.currents?.features.length ?? 0;
    case 'biomes':
    case 'mesh':
      return world.cells.features.length;
    case 'temperature':
      return world.cells.features.filter((feature) => feature.properties.temperature !== undefined).length;
    case 'precipitation':
      return world.cells.features.filter((feature) => feature.properties.precipitation !== undefined).length;
    case 'cultures':
      return world.dictionaries.cultures.length;
    case 'religions':
      return world.dictionaries.religions.length;
    case 'languages':
      return world.dictionaries.languages.length;
    case 'states':
    case 'regionBorders':
      return world.regions.features.length;
    case 'zones':
      return world.layers.zones?.features.length ?? 0;
    case 'rivers':
      return world.layers.rivers?.features.length ?? 0;
    case 'routes':
      return world.layers.routes?.features.length ?? 0;
    // города и метки живут во времени: показываем, сколько их сейчас на карте
    case 'burgs':
      return world.points.burgs.filter((burg) => pointVisibleAt(burg, time)).length;
    case 'markers':
      return world.points.markers.filter((marker) => pointVisibleAt(marker, time)).length;
  }
}

export class Sidebar {
  private root: HTMLElement;
  private renderQueued = false;
  private collapsed = new Set<string>(['Легенда', 'Симуляция ландшафта']);
  private simOptions: LandformOptions = { ...DEFAULT_LANDFORM_OPTIONS };
  private regionFilter = '';

  constructor(root: HTMLElement) {
    this.root = root;
    // панели перерисовываются не чаще кадра: во время мазка кистью правки идут пачками
    worldStore.subscribe(() => this.scheduleRender());
    uiStore.subscribe(() => this.scheduleRender());
    this.render();
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private section(title: string, build: (body: HTMLDivElement) => void): HTMLElement {
    const section = document.createElement('div');
    section.className = 'section';
    if (this.collapsed.has(title)) section.classList.add('collapsed');

    const heading = document.createElement('h3');
    heading.innerHTML = '<span class="caret">▼</span>';
    heading.append(title);
    heading.addEventListener('click', () => {
      if (this.collapsed.has(title)) this.collapsed.delete(title);
      else this.collapsed.add(title);
      this.render();
    });
    section.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'body';
    build(body);
    section.appendChild(body);
    return section;
  }

  /**
   * Перерисовка пересоздаёт DOM, поэтому прокрутка внутренних списков
   * (государства, регионы, события) сбрасывалась на начало при каждом клике.
   * Запоминаем её по ключу и возвращаем после сборки.
   */
  private saveListScroll(): Map<string, number> {
    const saved = new Map<string, number>();
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      saved.set(element.dataset.scrollKey!, element.scrollTop);
    }
    return saved;
  }

  private restoreListScroll(saved: Map<string, number>): void {
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const value = saved.get(element.dataset.scrollKey!);
      if (value) element.scrollTop = value;
    }
  }

  private render(): void {
    const scroll = this.root.scrollTop;
    const listScroll = this.saveListScroll();
    const world = worldStore.get();
    const ui = uiStore.get();
    this.root.replaceChildren();

    this.root.appendChild(this.section('Мир', (body) => this.renderWorld(body, world)));
    this.root.appendChild(this.section('Редактор', (body) => this.renderEditor(body, world, ui)));
    this.root.appendChild(this.section('Симуляция ландшафта', (body) => this.renderSimulation(body, world)));
    this.root.appendChild(this.section('Ветра и течения', (body) => this.renderWinds(body, world)));
    this.root.appendChild(this.section('Слои', (body) => this.renderLayers(body, world, ui)));
    this.root.appendChild(this.section('Легенда', (body) => this.renderLegend(body, world, ui)));
    this.root.appendChild(this.section('Государства', (body) => this.renderStates(body, world, ui)));
    this.root.appendChild(this.section('Регионы', (body) => this.renderRegions(body, world, ui)));

    this.root.scrollTop = scroll;
    this.restoreListScroll(listScroll);
  }

  /* ---------------------------- мир ---------------------------- */

  private renderWorld(body: HTMLDivElement, world: World): void {
    const row1 = document.createElement('div');
    row1.className = 'row wrap';
    row1.append(
      button('Демо-мир', () => loadSampleWorld()),
      button('Новая карта…', () => void newMapDialog(), '', 'Пустая карта заданного размера с сеткой ячеек'),
    );
    body.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'row wrap';
    row2.append(
      button(
        'Импорт мира (.zip)',
        async () => {
          const files = await pickFiles('.zip,.json');
          if (files.length) await guard(() => acceptFiles(files));
        },
        'primary',
      ),
    );
    body.appendChild(row2);

    const row3 = document.createElement('div');
    row3.className = 'row wrap';
    row3.append(
      button('Импорт Azgaar (JSON/GeoJSON/CSV)', async () => {
        const files = await pickFiles('.json,.geojson,.csv', true);
        if (files.length) await guard(() => acceptFiles(files));
      }),
    );
    body.appendChild(row3);

    const rowImage = document.createElement('div');
    rowImage.className = 'row wrap';
    rowImage.append(
      button(
        'Импорт картинки (SVG/PNG)',
        async () => {
          const files = await pickFiles('.svg,.png,.jpg,.jpeg,.webp');
          if (files.length) await guard(() => acceptFiles(files));
        },
        '',
        'SVG разбирается по фигурам, растр — по яркости и цветам через сетку ячеек',
      ),
    );
    body.appendChild(rowImage);

    const row4 = document.createElement('div');
    row4.className = 'row wrap';
    row4.append(
      button('Экспорт мира (.zip)', () => guard(() => exportArchive(false)), 'primary'),
      hasFileSystemAccess() ? button('Сохранить как…', () => guard(() => exportArchive(true))) : emptyNode(),
    );
    body.appendChild(row4);

    const stats = document.createElement('div');
    stats.className = 'tiny muted';
    stats.style.marginTop = '8px';
    stats.innerHTML = [
      `ячеек: ${world.cells.features.length}`,
      `регионов: ${world.regions.features.length}`,
      `государств: ${world.timeline.states.length}`,
      `городов: ${world.points.burgs.length}`,
      `меток: ${world.points.markers.length}`,
      `эпох: ${world.timeline.snapshots.length}`,
      `событий: ${world.timeline.events.length}`,
    ].join(' · ');
    body.appendChild(stats);

    const row5 = document.createElement('div');
    row5.className = 'row wrap';
    row5.style.marginTop = '8px';
    row5.append(
      button('Названия и переходы…', () => openNamesManager('states'), '', 'Правка всех имён, переименования по датам, переходы'),
    );
    body.appendChild(row5);

    const hint = document.createElement('div');
    hint.className = 'tiny muted';
    hint.style.marginTop = '6px';
    hint.textContent =
      'Понимает полный JSON Azgaar (Export → JSON → Full), GIS-экспорт GeoJSON и CSV-таблицы. Файлы можно перетащить в окно.';
    body.appendChild(hint);
  }

  /* ---------------------------- редактор ---------------------------- */

  private renderEditor(body: HTMLDivElement, world: World, ui: UiState): void {
    const tools = document.createElement('div');
    tools.className = 'row wrap';
    const toolButton = (id: UiState['tool'], label: string, title: string): HTMLButtonElement =>
      button(
        label,
        () => {
          uiStore.update((state) => {
            state.tool = id;
          });
        },
        ui.tool === id ? 'primary' : '',
        title,
      );
    tools.append(
      toolButton('select', 'Выбор', 'Обычный режим: пан, зум, выбор объектов'),
      toolButton('paint', 'Кисть', 'Красит атрибуты ячеек: политика, регионы, биомы, культуры…'),
      toolButton('height', 'Рельеф', 'Поднять / опустить / выровнять / размыть / берег'),
      toolButton('points', 'Точки', 'Ставить города и метки, переносить их перетаскиванием'),
      toolButton('route', 'Маршрут', 'Прокладывать дороги и морские пути между ячейками'),
      toolButton('vertices', 'Вершины', 'Двигать вершины границ региона (для регионов со своей геометрией)'),
    );
    body.appendChild(tools);

    if (ui.tool === 'select') {
      body.appendChild(
        hintText(
          'Клик — выбрать регион или ячейку, Alt+клик — государство-владельца. ' +
            'Колесо — зум, перетаскивание — панорама.',
        ),
      );
      return;
    }

    // у политики и географии разные умолчания, поэтому и переключатели разные
    const political = ui.tool === 'paint' && (ui.brush.target === 'stateId' || ui.brush.target === 'regionId');
    if (ui.tool === 'paint' || ui.tool === 'height') {
      body.appendChild(this.epochEditToggle(world, ui, political));
    }

    if (ui.tool === 'points') {
      const kinds = document.createElement('div');
      kinds.className = 'row wrap';
      for (const [kind, label, title] of [
        ['burg', 'Город', 'Кружок на карте, размер по населению'],
        ['marker', 'Метка', 'Значок с заметкой: руины, перевал, что угодно'],
      ] as const) {
        kinds.append(
          button(
            label,
            () => {
              uiStore.update((state) => {
                state.point.kind = kind;
              });
            },
            ui.point.kind === kind ? 'primary' : '',
            title,
          ),
        );
      }
      body.appendChild(kinds);

      if (ui.point.kind === 'marker') {
        const iconRow = document.createElement('div');
        iconRow.className = 'row';
        iconRow.style.marginTop = '8px';
        const caption = document.createElement('span');
        caption.className = 'tiny muted';
        caption.textContent = 'Значок';
        const icon = document.createElement('input');
        icon.type = 'text';
        icon.value = ui.point.icon;
        icon.addEventListener('change', () => {
          uiStore.update((state) => {
            state.point.icon = icon.value.trim() || '◆';
          });
        });
        iconRow.append(caption, icon);
        body.appendChild(iconRow);

        const presets = document.createElement('div');
        presets.className = 'row wrap';
        presets.style.marginTop = '6px';
        for (const glyph of ['◆', '⛰', '🗼', '🕳', '⚓', '⚔', '🔥', '🌋', '🏰']) {
          presets.append(
            button(glyph, () => {
              uiStore.update((state) => {
                state.point.icon = glyph;
              });
            }, ui.point.icon === glyph ? 'primary icon' : 'icon'),
          );
        }
        body.appendChild(presets);
      }

      body.appendChild(
        hintText(
          'Клик по карте ставит объект, перетаскивание существующего — переносит. ' +
            'Название и остальные поля — в правой панели.',
        ),
      );
      return;
    }

    if (ui.tool === 'route') {
      const groups = document.createElement('div');
      groups.className = 'row wrap';
      for (const [group, label, title] of [
        ['roads', 'Дорога', 'Идёт по суше, обходит горы'],
        ['trails', 'Тропа', 'То же, но рисуется пунктиром'],
        ['searoutes', 'Морской путь', 'Прокладывается только по воде'],
      ] as const) {
        groups.append(
          button(
            label,
            () => {
              uiStore.update((state) => {
                state.routeGroup = group;
              });
            },
            ui.routeGroup === group ? 'primary' : '',
            title,
          ),
        );
      }
      body.appendChild(groups);
      body.appendChild(
        hintText(
          'Клик ставит опорную точку, путь между опорами прокладывается сам по ячейкам ' +
            '(обходит горы, держится суши или воды). Enter — завершить, Backspace — убрать точку, Esc — отменить.',
        ),
      );
      body.appendChild(this.routeList(world));
      return;
    }

    if (ui.tool === 'vertices') {
      if (world.meta.regionSource === 'geometry') {
        body.appendChild(
          hintText(
            'Выберите регион, затем тяните белые вершины. Клик по границе — вставить вершину, Alt+клик по вершине — удалить.',
          ),
        );
      } else {
        body.appendChild(
          hintText(
            'В этом мире регионы собраны из ячеек, поэтому их границы двигаются кистью «Регион», а не вершинами. Инструмент вершин работает для миров с собственной геометрией регионов.',
          ),
        );
      }
      return;
    }

    if (ui.tool === 'height') {
      const ops = document.createElement('div');
      ops.className = 'row wrap';
      for (const op of HEIGHT_OPS) {
        ops.append(
          button(
            op.label,
            () => {
              uiStore.update((state) => {
                state.brush.heightOp = op.id;
              });
            },
            ui.brush.heightOp === op.id ? 'primary' : '',
            op.hint,
          ),
        );
      }
      body.appendChild(ops);
      body.appendChild(slider('Сила', 1, 20, 1, ui.brush.strength, (value) => {
        uiStore.update((state) => {
          state.brush.strength = value;
        });
      }));
      body.appendChild(slider('Размер кисти', 6, 90, 2, ui.brush.size, (value) => {
        uiStore.update((state) => {
          state.brush.size = value;
        });
      }));
      body.appendChild(
        hintText(
          world.layers.heightmap && !ui.geoEpochEdit
            ? 'При первой правке растровая сетка высот заменится рельефом по ячейкам.'
            : 'Кисть меняет высоту ячеек. Панорама в режиме правки — средней кнопкой или с Shift.',
        ),
      );
      return;
    }

    // --- кисть атрибутов
    const targets = document.createElement('div');
    targets.className = 'row wrap';
    for (const target of PAINT_TARGETS) {
      targets.append(
        button(
          target.label,
          () => {
            uiStore.update((state) => {
              state.brush.target = target.id;
              state.brush.value = defaultValueFor(world, target.id);
            });
          },
          ui.brush.target === target.id ? 'primary' : '',
        ),
      );
    }
    body.appendChild(targets);

    body.appendChild(this.valuePicker(world, ui));
    body.appendChild(slider('Размер кисти', 4, 90, 2, ui.brush.size, (value) => {
      uiStore.update((state) => {
        state.brush.size = value;
      });
    }));

    if (ui.brush.target === 'stateId') {
      const cleanup = document.createElement('div');
      cleanup.className = 'row wrap';
      cleanup.style.marginTop = '8px';
      cleanup.append(
        button(
          'Обрезать края',
          () => cutPoliticalEdges(ui.time, { epoch: ui.politicalEpochEdit }),
          '',
          'Убрать из территорий торчащие одиночные ячейки и закрашенную воду (текущая эпоха)',
        ),
      );
      body.appendChild(cleanup);
      body.appendChild(
        hintText(
          'Клик/протяжка по карте отдаёт закрашенные ячейки выбранному государству в текущей эпохе. ' +
            'Если задета лишь часть региона, он автоматически разрезается, а прошлые эпохи сохраняют своих владельцев.',
        ),
      );
    } else if (ui.brush.target === 'regionId') {
      body.appendChild(
        hintText(
          'Кисть переносит ячейки в выбранный регион — так и двигаются его границы. ' +
            'Значение «без региона» делает ячейки ничейными: они выпадают и из региона, и из государства.',
        ),
      );
    }
  }

  /** Список готовых маршрутов: переименование и удаление. */
  private routeList(world: World): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.marginTop = '8px';
    const routes = world.layers.routes?.features ?? [];
    if (routes.length === 0) {
      wrapper.appendChild(hintText('Маршрутов пока нет.'));
      return wrapper;
    }

    const list = document.createElement('div');
    list.className = 'list';
    list.dataset.scrollKey = 'routes';
    for (const feature of routes.slice(0, 200)) {
      const id = feature.properties.id;
      const row = document.createElement('div');
      row.className = 'state-row';

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      const group = String(feature.properties.group ?? 'roads');
      swatch.style.background = group === 'searoutes' ? '#9fd0f2' : group === 'trails' ? '#d8c39a' : '#f2dfb4';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = feature.properties.name ?? id;
      name.title = 'Двойной клик — переименовать';
      name.addEventListener('dblclick', () => {
        const next = window.prompt('Название маршрута', feature.properties.name ?? '');
        if (next) updateRoute(id, { name: next });
      });

      const remove = document.createElement('button');
      remove.className = 'icon danger rm';
      remove.textContent = '✕';
      remove.title = 'Удалить маршрут';
      remove.addEventListener('click', () => deleteRoute(id));

      row.append(swatch, name, remove);
      list.appendChild(row);
    }
    wrapper.appendChild(list);
    if (routes.length > 200) wrapper.appendChild(hintText(`Показаны первые 200 из ${routes.length}.`));
    return wrapper;
  }

  /**
   * Переключатель «правки в эпоху»: география начинает жить во времени —
   * с выбранной эпохи залив затоплен, степь стала пустыней и так далее.
   */
  private epochEditToggle(world: World, ui: UiState, political: boolean): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.marginTop = '8px';

    const snapshot = snapshotAt(world.timeline.snapshots, ui.time);
    const epochName = snapshot?.label ?? snapshot?.date ?? '—';
    const enabled = political ? ui.politicalEpochEdit : ui.geoEpochEdit;

    const label = document.createElement('label');
    label.className = 'layer-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    checkbox.addEventListener('change', () => {
      uiStore.update((state) => {
        if (political) state.politicalEpochEdit = checkbox.checked;
        else state.geoEpochEdit = checkbox.checked;
      });
      setStatus(
        checkbox.checked
          ? `Правки действуют с эпохи «${epochName}» и дальше`
          : 'Внимание: правки меняют базовую карту — сразу во всех эпохах',
      );
    });
    const text = document.createElement('span');
    text.textContent = political ? 'Менять только с этой эпохи' : 'Правки → в текущую эпоху';
    text.title = political
      ? 'Границы и принадлежность меняются начиная с выбранной эпохи, прошлое остаётся как было'
      : 'Рельеф, биомы, культуры будут меняться начиная с этой эпохи';
    label.append(checkbox, text);
    wrapper.appendChild(label);

    const count = countOverrides(snapshot);
    wrapper.appendChild(
      hintText(
        enabled
          ? political
            ? `Границы регионов и принадлежность лягут в эпоху «${epochName}» и будут действовать ` +
              'с неё и дальше. Прошлые эпохи не изменятся.'
            : `Рельеф, биомы, культуры, религии и языки лягут в эпоху «${epochName}» и будут ` +
              'действовать с неё и дальше. Базовая карта останется целой.'
          : 'Сейчас правки меняют базовую карту — то есть сразу все эпохи, включая прошлые.',
      ),
    );

    if (count > 0 && snapshot) {
      const row = document.createElement('div');
      row.className = 'row wrap';
      row.style.marginTop = '6px';
      const info = document.createElement('span');
      info.className = 'tiny muted grow';
      info.textContent = `Правок в этой эпохе: ${count}`;
      row.append(
        info,
        button('Сбросить', () => clearGeoOverrides(snapshot.id), 'danger', 'Убрать гео-правки этой эпохи'),
      );
      wrapper.appendChild(row);
    }
    return wrapper;
  }

  /** Список значений для кисти: биомы, справочники, регионы, государства. */
  private valuePicker(world: World, ui: UiState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.marginTop = '8px';

    const caption = document.createElement('div');
    caption.className = 'tiny muted';
    caption.textContent = 'Чем красим';
    wrapper.appendChild(caption);

    const select = document.createElement('select');
    const options: Array<{ value: string; label: string; color?: string }> = [];

    switch (ui.brush.target) {
      case 'biome': {
        const names = new Set<string>([
          ...world.dictionaries.biomes.map((entry) => entry.name),
          ...AZGAAR_BIOMES,
        ]);
        for (const name of names) options.push({ value: name, label: name, color: biomeColor(name) });
        break;
      }
      case 'cultureId':
        for (const entry of world.dictionaries.cultures) options.push({ value: entry.id, label: entry.name });
        break;
      case 'religionId':
        for (const entry of world.dictionaries.religions) options.push({ value: entry.id, label: entry.name });
        break;
      case 'languageId':
        for (const entry of world.dictionaries.languages) options.push({ value: entry.id, label: entry.name });
        break;
      case 'regionId':
        options.push({ value: '', label: '— без региона (ничейные ячейки) —' });
        for (const feature of world.regions.features) {
          options.push({ value: feature.properties.id, label: feature.properties.name ?? feature.properties.id });
        }
        break;
      case 'stateId':
        options.push({ value: 'none', label: '— ничьё —' });
        for (const state of world.timeline.states) options.push({ value: state.id, label: state.name });
        break;
    }

    if (ui.brush.target !== 'stateId' && ui.brush.target !== 'biome' && ui.brush.target !== 'regionId') {
      options.unshift({ value: '', label: '— сбросить значение —' });
    }

    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    // значение кисти могло остаться от другого мира/цели — подставляем первое доступное
    if (!options.some((option) => option.value === ui.brush.value)) {
      const fallback = options.find((option) => option.value !== '')?.value ?? '';
      if (fallback !== ui.brush.value) {
        queueMicrotask(() => {
          uiStore.update((state) => {
            state.brush.value = fallback;
          });
        });
      }
    }

    select.value = ui.brush.value;
    select.addEventListener('change', () => {
      uiStore.update((state) => {
        state.brush.value = select.value;
      });
    });
    wrapper.appendChild(select);

    const actions = document.createElement('div');
    actions.className = 'row wrap';
    actions.style.marginTop = '6px';

    const dictKind: DictKind | null =
      ui.brush.target === 'cultureId'
        ? 'cultures'
        : ui.brush.target === 'religionId'
          ? 'religions'
          : ui.brush.target === 'languageId'
            ? 'languages'
            : null;

    if (dictKind) {
      actions.append(
        button('+ создать', () => {
          const name = window.prompt('Название');
          if (!name) return;
          const index = world.dictionaries[dictKind].length;
          const id = addDictEntry(dictKind, name, CATEGORICAL[index % CATEGORICAL.length]);
          uiStore.update((state) => {
            state.brush.value = id;
          });
        }),
      );
    }
    if (ui.brush.target === 'regionId') {
      actions.append(
        button('+ регион', () => {
          const id = addRegion(window.prompt('Название региона') || undefined);
          uiStore.update((state) => {
            state.brush.value = id;
          });
        }),
      );
    }
    if (ui.brush.target === 'stateId') {
      actions.append(
        button('+ государство', () => {
          const id = addState(window.prompt('Название государства') || undefined);
          uiStore.update((state) => {
            state.brush.value = id;
          });
        }),
      );
    }
    if (actions.childElementCount > 0) wrapper.appendChild(actions);
    return wrapper;
  }

  /* ---------------------------- симуляция ---------------------------- */

  private renderSimulation(body: HTMLDivElement, world: World): void {
    const hasCells = world.cells.features.length > 0;
    body.appendChild(
      hintText(
        'Считает мир как модель: плиты дают хребты, ветер несёт влагу и роняет её на склонах, ' +
          'впадины заливаются в озёра, сток собирается в реки, биомы выводятся из климата.',
      ),
    );

    const options = this.simOptions;
    const checkbox = (
      label: string,
      key: 'terrain' | 'climate' | 'currents' | 'hydrology' | 'biomes',
      title: string,
    ): HTMLElement => {
      const wrapper = document.createElement('label');
      wrapper.className = 'layer-toggle';
      wrapper.title = title;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = options[key];
      input.addEventListener('change', () => {
        options[key] = input.checked;
        this.render();
      });
      const text = document.createElement('span');
      text.textContent = label;
      wrapper.append(input, text);
      return wrapper;
    };

    body.appendChild(checkbox('Рельеф с нуля (тектоника)', 'terrain', 'Сгенерировать высоты заново: плиты, хребты, рифты, шум'));
    body.appendChild(checkbox('Климат: температура и осадки', 'climate', 'Широта, высота, перенос влаги ветром'));

    // настройки климата живут в мире: их использует и симуляция, и слой ветров
    const climate = world.meta.climate ?? {};
    body.appendChild(
      slider('Экватор на широте, °', -80, 80, 5, Math.round(climate.equatorLat ?? 0), (value) => {
        updateClimateSettings({ equatorLat: value });
      }),
    );
    body.appendChild(
      slider('Температура на экваторе, °C', 0, 45, 1, Math.round(climate.temperatureEquator ?? 27), (value) => {
        updateClimateSettings({ temperatureEquator: value });
      }),
    );
    body.appendChild(
      slider('Температура на полюсе, °C', -60, 10, 2, Math.round(climate.temperaturePole ?? -24), (value) => {
        updateClimateSettings({ temperaturePole: value });
      }),
    );
    body.appendChild(
      hintText(
        'Экватор не обязан лежать на нуле: сдвиг переносит тепловой пояс и вместе с ним ' +
          'ветровые полосы, а значит и дождевую тень с пустынями. Слой «Ветра» показывает результат сразу.',
      ),
    );
    body.appendChild(
      checkbox('Течения: Экман и Кориолис', 'currents', 'Ветер тянет воду, Кориолис отклоняет, берега заворачивают поток'),
    );
    body.appendChild(checkbox('Гидрология: озёра и реки', 'hydrology', 'Заливка впадин и аккумуляция стока'));
    body.appendChild(checkbox('Пересобрать биомы', 'biomes', 'Биом выводится из температуры, осадков и воды'));

    if (options.terrain) {
      const coast = document.createElement('label');
      coast.className = 'layer-toggle';
      coast.title = 'Море остаётся морем, суша сушей — заново лепится только рельеф внутри материков';
      const coastInput = document.createElement('input');
      coastInput.type = 'checkbox';
      coastInput.checked = options.respectCoastline;
      coastInput.addEventListener('change', () => {
        options.respectCoastline = coastInput.checked;
        this.render();
      });
      const coastText = document.createElement('span');
      coastText.textContent = 'Сохранять берега (горы по существующей суше)';
      coast.append(coastInput, coastText);
      body.appendChild(coast);

      body.appendChild(
        slider('Тектонических плит', 2, 20, 1, options.plates, (value) => {
          options.plates = value;
        }),
      );
      if (!options.respectCoastline) {
        body.appendChild(
          slider('Доля моря, %', 5, 95, 5, Math.round(options.seaShare * 100), (value) => {
            options.seaShare = value / 100;
          }),
        );
        body.appendChild(
          slider('Отступ океана от краёв, %', 0, 45, 5, Math.round(options.edgeFalloff * 100), (value) => {
            options.edgeFalloff = value / 100;
          }),
        );
      }
      body.appendChild(
        slider('Изрезанность рельефа, %', 0, 100, 10, Math.round(options.roughness * 100), (value) => {
          options.roughness = value / 100;
        }),
      );
      body.appendChild(
        hintText(
          options.respectCoastline
            ? 'Береговая линия не изменится: поднимутся хребты вдоль коллизий плит и внутренние плато, ' +
              'глубины моря останутся как есть.'
            : 'Материки будут построены с нуля по плитам; отступ от краёв не даёт им упереться в рамку карты.',
        ),
      );
    }
    if (options.hydrology) {
      body.appendChild(
        slider('Порог реки, ‰ от максимума', 5, 300, 5, Math.round(options.riverThreshold * 1000), (value) => {
          options.riverThreshold = value / 1000;
        }),
      );
      body.appendChild(
        slider('Проходов эрозии', 0, 6, 1, options.erosion, (value) => {
          options.erosion = value;
        }),
      );
    }

    const actions = document.createElement('div');
    actions.className = 'row wrap';
    actions.style.marginTop = '8px';
    const run = button(
      'Запустить симуляцию',
      () => {
        const log = runLandformSimulation({ ...options });
        uiStore.update((state) => {
          if (options.hydrology) state.layers.rivers = true;
          if (options.biomes) state.layers.biomes = true;
        });
        window.alert(log.join('\n'));
      },
      'primary',
      'Одна запись в истории — результат можно отменить целиком',
    );
    run.disabled = !hasCells;
    actions.append(run);
    body.appendChild(actions);

    if (!hasCells) {
      body.appendChild(hintText('Нужна сетка ячеек: создайте новую карту или импортируйте мир.'));
    } else if (options.terrain) {
      body.appendChild(
        hintText('Рельеф будет перезаписан целиком, включая нарисованный вручную. Отменяется через Ctrl+Z.'),
      );
    }
  }

  /* ---------------------------- ветра ---------------------------- */

  private renderWinds(body: HTMLDivElement, world: World): void {
    const winds = world.layers.winds;
    const bands = winds?.bands ?? [];

    if (winds?.vectors && winds.vectors.length > 0) {
      body.appendChild(
        hintText(`В мире заданы явные векторы ветра (${winds.vectors.length}). Полосы недоступны, пока они есть.`),
      );
      const row = document.createElement('div');
      row.className = 'row wrap';
      row.append(button('Перейти на широтные полосы', () => dropWindVectors()));
      body.appendChild(row);
      return;
    }

    body.appendChild(
      hintText(
        'Ветер задан широтными полосами, как в Azgaar: от северной к южной. Осадки считаются ' +
          'переносом влаги по этим направлениям, а течения — ветром с отклонением Кориолиса.',
      ),
    );

    const equator = world.meta.climate?.equatorLat ?? 0;
    const span = bands.length > 0 ? 180 / bands.length : 30;

    bands.forEach((angle, index) => {
      const from = Math.round(equator + 90 - index * span);
      const to = Math.round(equator + 90 - (index + 1) * span);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginTop = '6px';

      const glyph = document.createElement('span');
      glyph.style.width = '16px';
      glyph.style.textAlign = 'center';
      glyph.textContent = arrowGlyph(angle);
      glyph.title = `Ветер дует в направлении ${angle}°`;

      const label = document.createElement('span');
      label.className = 'tiny muted';
      label.style.width = '74px';
      label.textContent = `${from}…${to}°`;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '350';
      input.step = '10';
      input.value = String(angle);
      input.addEventListener('input', () => {
        glyph.textContent = arrowGlyph(Number(input.value));
        value.textContent = `${input.value}°`;
      });
      input.addEventListener('change', () => {
        const next = [...bands];
        next[index] = Number(input.value);
        updateWindBands(next);
      });

      const value = document.createElement('span');
      value.className = 'tiny muted';
      value.style.width = '34px';
      value.textContent = `${angle}°`;

      row.append(glyph, label, input, value);
      body.appendChild(row);
    });

    const presets = document.createElement('div');
    presets.className = 'row wrap';
    presets.style.marginTop = '8px';
    presets.append(
      button('Как в Azgaar', () => updateWindBands([225, 45, 225, 315, 135, 315]), '', 'Пассаты и западные ветры по умолчанию'),
      button('Все западные', () => updateWindBands(new Array(Math.max(1, bands.length) || 6).fill(270))),
      button('+ полоса', () => updateWindBands([...bands, 270])),
      button('− полоса', () => {
        if (bands.length > 1) updateWindBands(bands.slice(0, -1));
      }),
    );
    body.appendChild(presets);

    const recalc = document.createElement('div');
    recalc.className = 'row wrap';
    recalc.style.marginTop = '8px';
    recalc.append(
      button(
        'Пересчитать климат',
        () => {
          runLandformSimulation({
            ...this.simOptions,
            terrain: false,
            erosion: 0,
            currents: true,
            climate: true,
          });
          uiStore.update((state) => {
            state.layers.currents = true;
          });
        },
        'primary',
        'Прогнать течения, температуру и осадки по текущим ветрам, не трогая рельеф',
      ),
    );
    body.appendChild(recalc);

    const currents = world.layers.currents?.features ?? [];
    if (currents.length > 0) {
      const warm = currents.filter((feature) => feature.properties.temperature === 'warm').length;
      body.appendChild(
        hintText(`Течений: ${currents.length} — тёплых ${warm}, холодных ${currents.length - warm}. Слой «Морские течения» в списке ниже.`),
      );
    }
  }

  /* ---------------------------- слои ---------------------------- */

  private renderLayers(body: HTMLDivElement, world: World, ui: UiState): void {
    for (const id of LAYER_IDS) {
      const count = layerCount(world, id, ui.time);
      const label = document.createElement('label');
      label.className = `layer-toggle${count === 0 ? ' empty' : ''}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ui.layers[id];
      checkbox.addEventListener('change', () => {
        uiStore.update((state) => {
          state.layers[id] = checkbox.checked;
        });
      });

      const text = document.createElement('span');
      text.textContent = LAYER_LABELS[id];

      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = String(count);

      label.append(checkbox, text, badge);
      body.appendChild(label);
    }

    const labelsToggle = document.createElement('label');
    labelsToggle.className = 'layer-toggle';
    const labelsCheckbox = document.createElement('input');
    labelsCheckbox.type = 'checkbox';
    labelsCheckbox.checked = ui.labels;
    labelsCheckbox.addEventListener('change', () => {
      uiStore.update((state) => {
        state.labels = labelsCheckbox.checked;
      });
    });
    const labelsText = document.createElement('span');
    labelsText.textContent = 'Подписи на карте';
    labelsToggle.append(labelsCheckbox, labelsText);
    body.appendChild(labelsToggle);

    body.appendChild(slider('Сглаживание границ', 0, 3, 1, ui.smoothing, (value) => {
      uiStore.update((state) => {
        state.smoothing = value;
      });
    }));
  }

  /* ---------------------------- легенда ---------------------------- */

  private renderLegend(body: HTMLDivElement, world: World, ui: UiState): void {
    const visible = LEGEND_LAYERS.filter((id) => ui.layers[id]);
    if (visible.length === 0) {
      body.appendChild(hintText('Включите тематический слой, чтобы увидеть легенду.'));
      return;
    }
    for (const layerId of visible) {
      const entries = legendFor(layerId, world, ui);
      if (entries.length === 0) continue;
      const heading = document.createElement('div');
      heading.className = 'tiny muted';
      heading.style.margin = '6px 0 3px';
      heading.textContent = LAYER_LABELS[layerId];
      body.appendChild(heading);

      for (const entry of entries.slice(0, 16)) {
        const item = document.createElement('div');
        item.className = 'legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = entry.color;
        const text = document.createElement('span');
        text.className = 'grow';
        text.textContent = entry.label;
        const count = document.createElement('span');
        count.className = 'tiny muted';
        count.textContent = entry.count !== undefined ? String(entry.count) : '';
        item.append(swatch, text, count);
        body.appendChild(item);
      }
      if (entries.length > 16) {
        const more = document.createElement('div');
        more.className = 'tiny muted';
        more.textContent = `…ещё ${entries.length - 16}`;
        body.appendChild(more);
      }
    }
  }

  /* ---------------------------- государства ---------------------------- */

  private renderStates(body: HTMLDivElement, world: World, ui: UiState): void {
    body.appendChild(
      hintText(
        ui.tool === 'paint' && ui.brush.target === 'stateId'
          ? 'Кисть государства активна: рисуйте по карте.'
          : 'Клик по государству включает кисть и рисование границ в текущей эпохе.',
      ),
    );

    const ownership = regionOwnershipAt(world, ui.time);
    const counts = new Map<string, number>();
    for (const owner of ownership.values()) {
      if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }

    const list = document.createElement('div');
    list.className = 'stack list';
    list.dataset.scrollKey = 'states';
    list.style.marginTop = '8px';

    for (const state of world.timeline.states) {
      const row = document.createElement('div');
      const active =
        (ui.selection?.kind === 'state' && ui.selection.id === state.id) ||
        (ui.tool === 'paint' && ui.brush.target === 'stateId' && ui.brush.value === state.id);
      row.className = `state-row${active ? ' active' : ''}`;

      const color = document.createElement('input');
      color.type = 'color';
      color.value = normalizeHex(state.color);
      color.addEventListener('change', () => updateState(state.id, { color: color.value }));
      color.addEventListener('click', (event) => event.stopPropagation());

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = nameAt(state, ui.time);
      name.title = 'Клик — рисовать этим государством, двойной клик — переименовать';
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const next = window.prompt('Название государства', state.name);
        if (next) updateState(state.id, { name: next });
      });

      const count = document.createElement('span');
      count.className = 'tiny muted';
      count.textContent = String(counts.get(state.id) ?? 0);

      const paint = document.createElement('button');
      paint.className = 'icon';
      paint.textContent = '✎';
      paint.title = 'Рисовать этим государством';
      paint.addEventListener('click', (event) => {
        event.stopPropagation();
        uiStore.update((draft) => {
          draft.tool = 'paint';
          draft.brush.target = 'stateId';
          draft.brush.value = state.id;
        });
        setStatus(`Кисть: ${nameAt(state, uiStore.get().time)}`);
      });

      const remove = document.createElement('button');
      remove.className = 'icon danger rm';
      remove.textContent = '✕';
      remove.title = 'Удалить государство';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        if (confirmDialog(`Удалить «${state.name}»? Регионы станут ничьими во всех эпохах.`)) {
          deleteState(state.id);
        }
      });

      row.append(color, name, count, paint, remove);
      // клик выбирает государство: детали и действия — в правой панели
      row.addEventListener('click', () => {
        uiStore.update((draft) => {
          draft.selection = { kind: 'state', id: state.id };
          draft.brush.value = state.id;
          if (draft.tool === 'paint') draft.brush.target = 'stateId';
        });
      });
      list.appendChild(row);
    }
    body.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'row wrap';
    actions.style.marginTop = '8px';
    actions.append(
      button('+ государство', () => {
        const id = addState(window.prompt('Название государства') || undefined);
        uiStore.update((state) => {
          state.tool = 'paint';
          state.brush.target = 'stateId';
          state.brush.value = id;
        });
      }),
      button('Кисть «ничьё»', () => {
        uiStore.update((state) => {
          state.tool = 'paint';
          state.brush.target = 'stateId';
          state.brush.value = 'none';
        });
        setStatus('Кисть: снять принадлежность');
      }),
      button(
        'Обрезать края',
        () => cutPoliticalEdges(ui.time, { epoch: ui.politicalEpochEdit }),
        '',
        'Убрать торчащие одиночные ячейки и закрашенную воду из территорий (текущая эпоха)',
      ),
      button('Названия…', () => openNamesManager('states')),
      button(
        'Очистить всё',
        () => {
          void (async () => {
            // читаем состояние на момент клика, а не на момент отрисовки кнопки
            const count = worldStore.get().timeline.states.length;
            if (count === 0) {
              setStatus('Государств и так нет');
              return;
            }
            const ok = await confirmModal({
              title: 'Очистить все государства?',
              message:
                `Будет удалено государств: ${count}.\n` +
                'Регионы и ячейки останутся, но станут ничьими во всех эпохах.\n' +
                'Действие отменяется через Ctrl+Z.',
              submitLabel: 'Удалить все',
            });
            if (ok) clearAllStates();
          })();
        },
        'danger',
        'Удалить все государства разом',
      ),
    );
    body.appendChild(actions);
  }

  /* ---------------------------- регионы ---------------------------- */

  private renderRegions(body: HTMLDivElement, world: World, ui: UiState): void {
    const filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = 'Поиск региона…';
    filter.value = this.regionFilter;
    filter.addEventListener('input', () => {
      this.regionFilter = filter.value;
      this.render();
    });
    body.appendChild(filter);

    const query = this.regionFilter.trim().toLowerCase();
    const ownership = regionOwnershipAt(world, ui.time);
    // регионы не статичны: в разные эпохи у них разный набор ячеек
    const cellCounts = regionCellCounts(world, ui.time);
    const matches = world.regions.features.filter((feature) => {
      if (!query) return true;
      const name = (feature.properties.name ?? feature.properties.id).toLowerCase();
      return name.includes(query);
    });

    const list = document.createElement('div');
    list.className = 'list';
    list.dataset.scrollKey = 'regions';
    list.style.marginTop = '6px';

    for (const feature of matches.slice(0, 120)) {
      const id = feature.properties.id;
      const row = document.createElement('div');
      const active = ui.selection?.kind === 'region' && ui.selection.id === id;
      row.className = `state-row${active ? ' active' : ''}`;

      const owner = world.timeline.states.find((state) => state.id === ownership.get(id));
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = owner?.color ?? 'rgba(120,130,145,0.4)';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = nameAt(
        { id, name: feature.properties.name, names: feature.properties.names },
        ui.time,
      );
      name.title = owner ? `Владелец сейчас: ${owner.name}` : 'Ничьё';

      const size = document.createElement('span');
      size.className = 'tiny muted';
      const count = cellCounts.get(id) ?? 0;
      size.textContent = count > 0 ? String(count) : '—';
      size.title = count > 0 ? `Ячеек в этой эпохе: ${count}` : 'В этой эпохе регион пуст';
      if (count === 0) row.style.opacity = '0.55';

      const paint = document.createElement('button');
      paint.className = 'icon';
      paint.textContent = '✎';
      paint.title = 'Рисовать этот регион кистью';
      paint.addEventListener('click', (event) => {
        event.stopPropagation();
        uiStore.update((state) => {
          state.tool = 'paint';
          state.brush.target = 'regionId';
          state.brush.value = id;
        });
        setStatus(`Кисть региона: ${feature.properties.name ?? id}`);
      });

      const remove = document.createElement('button');
      remove.className = 'icon danger rm';
      remove.textContent = '✕';
      remove.title = 'Удалить регион';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        if (confirmDialog(`Удалить регион «${feature.properties.name ?? id}»?`)) deleteRegion(id);
      });

      row.append(swatch, name, size, paint, remove);
      row.addEventListener('click', () => {
        uiStore.update((state) => {
          state.selection = { kind: 'region', id };
        });
      });
      list.appendChild(row);
    }
    body.appendChild(list);

    if (matches.length > 120) {
      body.appendChild(hintText(`Показаны первые 120 из ${matches.length}. Уточните поиск.`));
    }
    body.appendChild(
      hintText('Цифра — сколько ячеек у региона в текущей эпохе. Пустые в этой эпохе показаны бледнее.'),
    );

    const actions = document.createElement('div');
    actions.className = 'row wrap';
    actions.style.marginTop = '8px';
    actions.append(
      button('Названия…', () => openNamesManager('regions')),
      button(
        'Очистить всё',
        () => {
          void (async () => {
            const count = worldStore.get().regions.features.length;
            if (count === 0) {
              setStatus('Регионов и так нет');
              return;
            }
            const ok = await confirmModal({
              title: 'Очистить все регионы?',
              message:
                `Будет удалено регионов: ${count}.\n` +
                'Ячейки останутся, но потеряют регион — вместе с ним пропадёт и политика ' +
                'во всех эпохах, включая правки эпох.\n' +
                'Действие отменяется через Ctrl+Z.',
              submitLabel: 'Удалить все',
              requirePhrase: count > 50 ? 'очистить' : undefined,
            });
            if (ok) clearAllRegions();
          })();
        },
        'danger',
        'Удалить все регионы разом',
      ),
      button('+ регион', () => {
        const id = addRegion(window.prompt('Название региона') || undefined);
        uiStore.update((state) => {
          state.tool = 'paint';
          state.brush.target = 'regionId';
          state.brush.value = id;
          state.layers.regionBorders = true;
        });
        setStatus('Новый регион создан — закрасьте для него ячейки');
      }),
    );
    body.appendChild(actions);
  }
}

/** Диалог создания пустой карты: размер, детализация, стартовый рельеф. */
export async function newMapDialog(): Promise<void> {
  const result = await openForm({
    title: 'Новая карта',
    submitLabel: 'Создать',
    fields: [
      { name: 'name', label: 'Название мира', value: 'Новый мир' },
      { name: 'lonSpan', label: 'Ширина карты, ° долготы', type: 'number', value: String(DEFAULT_BLANK_OPTIONS.lonSpan) },
      { name: 'latSpan', label: 'Высота карты, ° широты', type: 'number', value: String(DEFAULT_BLANK_OPTIONS.latSpan) },
      {
        name: 'cells',
        label: 'Детализация: число ячеек (чем больше, тем тоньше границы)',
        type: 'number',
        value: String(DEFAULT_BLANK_OPTIONS.cells),
      },
      {
        name: 'relief',
        label: 'Стартовый рельеф',
        type: 'select',
        value: 'continents',
        options: [
          { value: 'continents', label: 'Несколько континентов (можно лепить дальше)' },
          { value: 'ocean', label: 'Всё океан — поднимать землю кистью' },
          { value: 'land', label: 'Всё суша — вырезать моря кистью' },
        ],
      },
    ],
  });
  if (!result) return;
  createBlank({
    name: result.name.trim() || 'Новый мир',
    lonSpan: Number(result.lonSpan) || DEFAULT_BLANK_OPTIONS.lonSpan,
    latSpan: Number(result.latSpan) || DEFAULT_BLANK_OPTIONS.latSpan,
    cells: Number(result.cells) || DEFAULT_BLANK_OPTIONS.cells,
    relief: (result.relief as ReliefPreset) ?? 'continents',
  });
}

/* ---------------------------- мелкие хелперы ---------------------------- */

function defaultValueFor(world: World, target: PaintTarget): string {
  switch (target) {
    case 'biome':
      return world.dictionaries.biomes[0]?.name ?? AZGAAR_BIOMES[4];
    case 'cultureId':
      return world.dictionaries.cultures[0]?.id ?? '';
    case 'religionId':
      return world.dictionaries.religions[0]?.id ?? '';
    case 'languageId':
      return world.dictionaries.languages[0]?.id ?? '';
    case 'regionId':
      return world.regions.features[0]?.properties.id ?? '';
    case 'stateId':
      return world.timeline.states[0]?.id ?? 'none';
  }
}

function button(label: string, onClick: () => void, className = '', title = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  if (className) element.className = className;
  if (title) element.title = title;
  element.addEventListener('click', onClick);
  return element;
}

function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (value: number) => void,
): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.style.display = 'block';
  wrapper.style.marginTop = '8px';

  const caption = document.createElement('div');
  caption.className = 'tiny muted';
  caption.textContent = `${label}: ${value}`;
  wrapper.appendChild(caption);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    caption.textContent = `${label}: ${input.value}`;
  });
  input.addEventListener('change', () => onChange(Number(input.value)));
  wrapper.appendChild(input);
  return wrapper;
}

function hintText(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'tiny muted';
  element.style.marginTop = '6px';
  element.textContent = text;
  return element;
}

function emptyNode(): DocumentFragment {
  return document.createDocumentFragment();
}

/** Стрелка направления: ветер дует В указанную сторону. */
function arrowGlyph(angle: number): string {
  const glyphs = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const index = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return glyphs[index];
}

function normalizeHex(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#888888';
}

async function guard(action: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error);
    setStatus(`Ошибка: ${(error as Error).message}`, 8000);
    window.alert(`Не получилось: ${(error as Error).message}`);
  }
}
