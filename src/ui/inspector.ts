import {
  assignRegionState,
  createRegionFromState,
  createStateFromRegion,
  deleteBurg,
  deleteEvent,
  deleteMarker,
  deleteRegion,
  deleteState,
  renameEntity,
  renameRegion,
  setEntityColor,
  updateBurg,
  updateEvent,
  updateMarker,
  updateMarkerNote,
} from '../state/edits';
import { countOverrides, effectiveProperties, overridesAt, regionCellCounts } from '../state/geoOverrides';
import { resolveStateId } from '../state/naming';
import { nameAt, pointVisibleAt, regionNameAt, stateAt } from '../state/naming';
import { formatDate, snapshotAt, toNumericDate } from '../state/time';
import type { World } from '../state/types';
import { uiStore, type UiState } from '../state/ui';
import { regionCellCounts as regionCells } from '../state/geoOverrides';
import { regionOwnershipAt, worldStore } from '../state/world';
import { setTime } from '../timeline/timelineView';
import { confirmDialog, openForm } from './dialog';
import { openNamesManager } from './namesManager';

export class Inspector {
  private root: HTMLElement;
  private renderQueued = false;
  private collapsed = new Set<string>();

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

    this.root.appendChild(this.section('Выбранный объект', (body) => this.renderSelection(body, world, ui)));
    this.root.appendChild(this.section('Текущая эпоха', (body) => this.renderSnapshot(body, world, ui)));
    this.root.appendChild(this.section('События', (body) => this.renderEvents(body, world, ui)));

    this.root.scrollTop = scroll;
    this.restoreListScroll(listScroll);
  }

  /* ------------------------- выбранный объект ------------------------- */

  private renderSelection(body: HTMLDivElement, world: World, ui: UiState): void {
    const selection = ui.selection;
    if (!selection) {
      body.appendChild(muted('Кликните по региону, ячейке, городу или метке на карте.'));
      return;
    }

    if (selection.kind === 'state') {
      this.renderStateSelection(body, world, ui, selection.id);
      return;
    }

    if (selection.kind === 'region') {
      const feature = world.regions.features.find((item) => item.properties.id === selection.id);
      if (!feature) {
        body.appendChild(muted('Регион не найден.'));
        return;
      }
      const name = document.createElement('input');
      name.type = 'text';
      name.value = feature.properties.name ?? feature.properties.id;
      name.addEventListener('change', () => renameRegion(selection.id, name.value));
      body.appendChild(labeled('Название региона', name));

      const currentName = regionNameAt(world, selection.id, ui.time);
      const nameRow = document.createElement('div');
      nameRow.className = 'row';
      nameRow.style.marginTop = '4px';
      if (currentName !== (feature.properties.name ?? feature.properties.id)) {
        const now = document.createElement('span');
        now.className = 'tiny muted grow';
        now.textContent = `на ${formatDate(ui.time, world.meta.era)}: ${currentName}`;
        nameRow.appendChild(now);
      }
      const historyButton = document.createElement('button');
      historyButton.className = 'icon';
      historyButton.textContent = '⏱ переименования';
      historyButton.title = 'История названий и переходов';
      historyButton.addEventListener('click', () => openNamesManager('regions'));
      nameRow.appendChild(historyButton);
      body.appendChild(nameRow);

      const ownership = regionOwnershipAt(world, ui.time);
      const owner = ownership.get(selection.id) ?? '';

      const select = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— ничьё —';
      select.appendChild(none);
      for (const state of world.timeline.states) {
        const option = document.createElement('option');
        option.value = state.id;
        option.textContent = nameAt(state, ui.time);
        select.appendChild(option);
      }
      select.value = owner;
      select.addEventListener('change', () => assignRegionState(selection.id, select.value || null));
      body.appendChild(
        labeled(`Принадлежность на ${formatDate(ui.time, world.meta.era)}`, select),
      );

      const actions = document.createElement('div');
      actions.className = 'row wrap';
      actions.style.marginTop = '8px';
      if (owner) {
        actions.append(
          button('Выбрать государство', () => {
            uiStore.update((state) => {
              state.selection = { kind: 'state', id: owner };
            });
          }),
        );
      }
      actions.append(
        button(
          'Кисть этим регионом',
          () => {
            uiStore.update((state) => {
              state.tool = 'paint';
              state.brush.target = 'regionId';
              state.brush.value = selection.id;
              state.layers.regionBorders = true;
            });
          },
          'primary',
          'Переносить ячейки в этот регион — так и двигаются его границы',
        ),
        button(
          '+ государство с этим именем',
          () => {
            const id = createStateFromRegion(selection.id, ui.time);
            if (!id) return;
            uiStore.update((state) => {
              state.selection = { kind: 'state', id };
            });
          },
          '',
          'Создаёт государство с названием региона и отдаёт ему регион в текущей эпохе',
        ),
        button(
          'Удалить',
          () => {
            const name = regionNameAt(world, selection.id, ui.time);
            if (!confirmDialog(`Удалить регион «${name}»? Ячейки останутся, но потеряют регион.`)) return;
            deleteRegion(selection.id);
            uiStore.update((state) => {
              state.selection = null;
            });
          },
          'danger',
          'Удаляет регион во всех эпохах; ячейки становятся без региона',
        ),
      );
      body.appendChild(actions);

      const cells = regionCellCounts(world, ui.time).get(selection.id) ?? 0;
      const size = document.createElement('div');
      size.className = 'tiny muted';
      size.style.marginTop = '6px';
      size.textContent = `Ячеек в этой эпохе: ${cells}`;
      body.appendChild(size);

      const history = document.createElement('div');
      history.className = 'tiny muted';
      history.style.marginTop = '8px';
      const lines = world.timeline.snapshots
        .slice()
        .sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date))
        .filter((snapshot) => snapshot.regionState[selection.id] !== undefined)
        .map((snapshot) => {
          const stateId = snapshot.regionState[selection.id];
          const state = stateAt(world, stateId, toNumericDate(snapshot.date));
          return `${snapshot.date}: ${state?.name ?? 'ничьё'}`;
        });
      history.textContent = lines.length ? `История: ${lines.join(' → ')}` : 'История: нет записей в эпохах';
      body.appendChild(history);
      return;
    }

    if (selection.kind === 'cell') {
      const feature = world.cells.features.find((item) => item.properties.id === selection.id);
      if (!feature) {
        body.appendChild(muted('Ячейка не найдена.'));
        return;
      }
      // показываем то, что действует на текущий момент: база плюс правки эпохи
      const properties = effectiveProperties(feature, overridesAt(world, ui.time));
      const culture = world.dictionaries.cultures.find((item) => item.id === properties.cultureId);
      const religion = world.dictionaries.religions.find((item) => item.id === properties.religionId);
      const language = world.dictionaries.languages.find((item) => item.id === properties.languageId);
      body.appendChild(
        keyValue([
          ['id', properties.id],
          ['высота', properties.height !== undefined ? String(properties.height) : '—'],
          ['биом', properties.biome ?? '—'],
          ['культура', culture?.name ?? properties.cultureId ?? '—'],
          ['религия', religion?.name ?? properties.religionId ?? '—'],
          ['язык', language?.name ?? properties.languageId ?? '—'],
          ['население', properties.population !== undefined ? String(properties.population) : '—'],
        ]),
      );
      return;
    }

    if (selection.kind === 'burg') {
      const burg = world.points.burgs.find((item) => item.id === selection.id);
      if (!burg) {
        body.appendChild(muted('Город не найден.'));
        return;
      }

      const name = document.createElement('input');
      name.type = 'text';
      name.value = burg.name;
      name.addEventListener('change', () => {
        if (name.value.trim()) updateBurg(burg.id, { name: name.value.trim() });
      });
      body.appendChild(labeled('Название города', name));

      const currentName = nameAt(burg, ui.time);
      const nameRow = document.createElement('div');
      nameRow.className = 'row';
      nameRow.style.marginTop = '4px';
      if (currentName !== burg.name) {
        const now = document.createElement('span');
        now.className = 'tiny muted grow';
        now.textContent = `на ${formatDate(ui.time, world.meta.era)}: ${currentName}`;
        nameRow.appendChild(now);
      }
      const history = document.createElement('button');
      history.className = 'icon';
      history.textContent = '⏱ переименования';
      history.title = 'История названий по эпохам';
      history.addEventListener('click', () => openNamesManager('burgs'));
      nameRow.appendChild(history);
      body.appendChild(nameRow);

      const population = document.createElement('input');
      population.type = 'number';
      population.value = String(burg.population ?? 0);
      population.addEventListener('change', () =>
        updateBurg(burg.id, { population: Math.max(0, Number(population.value) || 0) }),
      );
      body.appendChild(labeled('Население (условные единицы)', population));

      const flags = document.createElement('div');
      flags.className = 'row wrap';
      flags.style.marginTop = '8px';
      for (const [key, label, title] of [
        ['capital', 'Столица', 'Рисуется крупнее и подписывается на любом масштабе'],
        ['port', 'Порт', 'Пометка портового города'],
      ] as const) {
        const toggle = document.createElement('label');
        toggle.className = 'layer-toggle';
        toggle.title = title;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(burg[key]);
        input.addEventListener('change', () => updateBurg(burg.id, { [key]: input.checked }));
        const text = document.createElement('span');
        text.textContent = label;
        toggle.append(input, text);
        flags.appendChild(toggle);
      }
      body.appendChild(flags);

      this.renderLifespan(body, world, ui, burg, (patch) => updateBurg(burg.id, patch));

      const state = stateAt(world, burg.stateId, ui.time);
      body.appendChild(
        keyValue([
          ['координаты', `${burg.x.toFixed(2)}, ${burg.y.toFixed(2)}`],
          ['государство', state?.name ?? '—'],
        ]),
      );

      const actions = document.createElement('div');
      actions.className = 'row wrap';
      actions.style.marginTop = '8px';
      actions.append(
        button('Удалить', () => {
          if (!confirmDialog(`Удалить город «${burg.name}»?`)) return;
          deleteBurg(burg.id);
          uiStore.update((state2) => {
            state2.selection = null;
          });
        }, 'danger'),
      );
      body.appendChild(actions);
      body.appendChild(
        hintText('Инструмент «Точки»: перетаскиванием город можно двигать по карте.'),
      );
      return;
    }

    const marker = world.points.markers.find((item) => item.id === selection.id);
    if (!marker) {
      body.appendChild(muted('Метка не найдена.'));
      return;
    }

    const markerName = document.createElement('input');
    markerName.type = 'text';
    markerName.value = marker.name;
    markerName.addEventListener('change', () => {
      if (markerName.value.trim()) updateMarker(marker.id, { name: markerName.value.trim() });
    });
    body.appendChild(labeled('Название метки', markerName));

    const markerCurrent = nameAt(marker, ui.time);
    if (markerCurrent !== marker.name) {
      const now = document.createElement('div');
      now.className = 'tiny muted';
      now.style.marginTop = '4px';
      now.textContent = `на ${formatDate(ui.time, world.meta.era)}: ${markerCurrent}`;
      body.appendChild(now);
    }

    const iconRow = document.createElement('input');
    iconRow.type = 'text';
    iconRow.value = marker.icon ?? '◆';
    iconRow.addEventListener('change', () => updateMarker(marker.id, { icon: iconRow.value.trim() || '◆' }));
    body.appendChild(labeled('Значок', iconRow));

    const type = document.createElement('input');
    type.type = 'text';
    type.value = marker.type ?? '';
    type.addEventListener('change', () => updateMarker(marker.id, { type: type.value.trim() || undefined }));
    body.appendChild(labeled('Тип', type));

    const note = document.createElement('textarea');
    note.value = marker.note ?? '';
    note.addEventListener('change', () => updateMarkerNote(marker.id, note.value));
    body.appendChild(labeled('Заметка', note));

    this.renderLifespan(body, world, ui, marker, (patch) => updateMarker(marker.id, patch));

    body.appendChild(keyValue([['координаты', `${marker.x.toFixed(2)}, ${marker.y.toFixed(2)}`]]));

    const markerActions = document.createElement('div');
    markerActions.className = 'row wrap';
    markerActions.style.marginTop = '8px';
    markerActions.append(
      button('Удалить', () => {
        if (!confirmDialog(`Удалить метку «${marker.name}»?`)) return;
        deleteMarker(marker.id);
        uiStore.update((state) => {
          state.selection = null;
        });
      }, 'danger'),
    );
    body.appendChild(markerActions);
  }

  /** Государство как объект: имя, цвет, владения на текущий момент и действия. */
  private renderStateSelection(body: HTMLDivElement, world: World, ui: UiState, stateId: string): void {
    const state = world.timeline.states.find((item) => item.id === stateId);
    if (!state) {
      body.appendChild(muted('Государство не найдено.'));
      return;
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = state.name;
    nameInput.addEventListener('change', () => {
      if (nameInput.value.trim()) renameEntity('states', stateId, nameInput.value.trim());
    });
    body.appendChild(labeled('Название государства', nameInput));

    const currentName = nameAt(state, ui.time);
    if (currentName !== state.name) {
      const now = document.createElement('div');
      now.className = 'tiny muted';
      now.style.marginTop = '4px';
      now.textContent = `на ${formatDate(ui.time, world.meta.era)}: ${currentName}`;
      body.appendChild(now);
    }

    const color = document.createElement('input');
    color.type = 'color';
    color.value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#888888';
    color.addEventListener('change', () => setEntityColor('states', stateId, color.value));
    body.appendChild(labeled('Цвет', color));

    // сколько у него сейчас регионов и ячеек — владения меняются по эпохам
    const ownership = regionOwnershipAt(world, ui.time);
    const cells = regionCells(world, ui.time);
    let regions = 0;
    let cellCount = 0;
    for (const [regionId, owner] of ownership) {
      if (resolveStateId(world, owner, ui.time) !== stateId) continue;
      regions += 1;
      cellCount += cells.get(regionId) ?? 0;
    }
    body.appendChild(
      keyValue([
        ['регионов сейчас', String(regions)],
        ['ячеек сейчас', String(cellCount)],
        ['переименований', String(state.names?.length ?? 0)],
        ['переходов', String(state.succeededBy?.length ?? 0)],
      ]),
    );

    const actions = document.createElement('div');
    actions.className = 'row wrap';
    actions.style.marginTop = '8px';
    actions.append(
      button('Кисть этим государством', () => {
        uiStore.update((draft) => {
          draft.tool = 'paint';
          draft.brush.target = 'stateId';
          draft.brush.value = stateId;
        });
      }, 'primary'),
      button(
        '+ регион с этим именем',
        () => {
          const id = createRegionFromState(stateId, ui.time);
          if (!id) return;
          uiStore.update((draft) => {
            draft.selection = { kind: 'region', id };
            draft.tool = 'paint';
            draft.brush.target = 'regionId';
            draft.brush.value = id;
            draft.layers.regionBorders = true;
          });
        },
        '',
        'Создаёт регион с названием государства и закрепляет его за ним в текущей эпохе',
      ),
      button('Переименования…', () => openNamesManager('states')),
      button('Удалить', () => {
        if (confirmDialog(`Удалить «${state.name}»? Регионы станут ничьими во всех эпохах.`)) {
          deleteState(stateId);
          uiStore.update((draft) => {
            draft.selection = null;
          });
        }
      }, 'danger'),
    );
    body.appendChild(actions);
  }

  /**
   * Даты жизни точки: основана / исчезла. Пустые поля — «существует всегда».
   * Кнопки ставят текущую эпоху одним нажатием, потому что именно так это и
   * делается по ходу работы с таймлайном.
   */
  private renderLifespan(
    body: HTMLDivElement,
    world: World,
    ui: UiState,
    point: { id: string; from?: string; to?: string },
    apply: (patch: { from?: string; to?: string }) => void,
  ): void {
    const now = String(Math.round(ui.time));

    const from = document.createElement('input');
    from.type = 'text';
    from.placeholder = 'всегда';
    from.value = point.from ?? '';
    from.addEventListener('change', () => apply({ from: from.value.trim() || undefined }));
    body.appendChild(labeled('Существует с даты', from));

    const to = document.createElement('input');
    to.type = 'text';
    to.placeholder = 'всегда';
    to.value = point.to ?? '';
    to.addEventListener('change', () => apply({ to: to.value.trim() || undefined }));
    body.appendChild(labeled('Исчезает с даты', to));

    const quick = document.createElement('div');
    quick.className = 'row wrap';
    quick.style.marginTop = '8px';
    quick.append(
      button('Основать с этой эпохи', () => apply({ from: now }), '', `Поставит дату ${now}`),
      button('Разрушить с этой эпохи', () => apply({ to: now }), '', `Поставит дату ${now}`),
      button('Существует всегда', () => apply({ from: undefined, to: undefined })),
    );
    body.appendChild(quick);

    const visible = pointVisibleAt(point, ui.time);
    body.appendChild(
      hintText(
        visible
          ? `На ${formatDate(ui.time, world.meta.era)} объект есть на карте.`
          : `На ${formatDate(ui.time, world.meta.era)} объекта на карте нет — он вне своих дат.`,
      ),
    );
  }

  /* ------------------------- эпоха ------------------------- */

  private renderSnapshot(body: HTMLDivElement, world: World, ui: UiState): void {
    const snapshot = snapshotAt(world.timeline.snapshots, ui.time);
    if (!snapshot) {
      body.appendChild(muted('Эпох пока нет. Нажмите «+ Эпоха» на шкале времени внизу.'));
      return;
    }
    const assigned = Object.values(snapshot.regionState).filter(Boolean).length;
    const geoCount = countOverrides(snapshot);
    body.appendChild(
      keyValue([
        ['дата', snapshot.date],
        ['название', snapshot.label ?? '—'],
        ['регионов занято', `${assigned} из ${world.regions.features.length}`],
        ['гео-правок', geoCount > 0 ? String(geoCount) : '—'],
      ]),
    );
    if (snapshot.notes) {
      const notes = document.createElement('div');
      notes.className = 'small';
      notes.style.marginTop = '6px';
      notes.textContent = snapshot.notes;
      body.appendChild(notes);
    }
  }

  /* ------------------------- события ------------------------- */

  private renderEvents(body: HTMLDivElement, world: World, ui: UiState): void {
    const events = world.timeline.events
      .slice()
      .sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));

    if (events.length === 0) {
      body.appendChild(muted('Событий нет. Кнопка «+ Событие» на шкале времени.'));
      return;
    }

    const list = document.createElement('div');
    list.className = 'list';
    list.dataset.scrollKey = 'events';
    for (const event of events) {
      const item = document.createElement('div');
      item.className = `item${ui.selectedEventId === event.id ? ' active' : ''}`;

      const header = document.createElement('div');
      header.className = 'row';
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = event.date;
      const title = document.createElement('span');
      title.className = 'title grow';
      title.textContent = event.title;
      header.append(date, title);
      item.appendChild(header);

      if (event.description) {
        const description = document.createElement('div');
        description.className = 'tiny muted';
        description.textContent = event.description;
        item.appendChild(description);
      }
      if (event.regionId) {
        const region = world.regions.features.find((feature) => feature.properties.id === event.regionId);
        const link = document.createElement('div');
        link.className = 'tiny muted';
        link.textContent = `регион: ${region?.properties.name ?? event.regionId}`;
        item.appendChild(link);
      }

      const actions = document.createElement('div');
      actions.className = 'row';
      actions.style.marginTop = '4px';
      const edit = document.createElement('button');
      edit.className = 'icon';
      edit.textContent = 'Правка';
      edit.addEventListener('click', async (native) => {
        native.stopPropagation();
        const result = await openForm({
          title: 'Событие',
          fields: [
            { name: 'date', label: 'Дата', value: event.date },
            { name: 'title', label: 'Название', value: event.title },
            { name: 'description', label: 'Описание', type: 'textarea', value: event.description ?? '' },
            {
              name: 'regionId',
              label: 'Регион',
              type: 'select',
              value: event.regionId ?? '',
              options: [
                { value: '', label: '— нет —' },
                ...world.regions.features.map((feature) => ({
                  value: feature.properties.id,
                  label: feature.properties.name ?? feature.properties.id,
                })),
              ],
            },
          ],
        });
        if (!result) return;
        updateEvent(event.id, {
          date: result.date,
          title: result.title,
          description: result.description || undefined,
          regionId: result.regionId || undefined,
        });
      });
      const remove = document.createElement('button');
      remove.className = 'icon danger';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', (native) => {
        native.stopPropagation();
        if (confirmDialog(`Удалить событие «${event.title}»?`)) deleteEvent(event.id);
      });
      actions.append(edit, remove);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        uiStore.update((state) => {
          state.selectedEventId = event.id;
          if (event.regionId) state.selection = { kind: 'region', id: event.regionId };
        });
        setTime(toNumericDate(event.date));
      });
      list.appendChild(item);
    }
    body.appendChild(list);
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

function hintText(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'tiny muted';
  element.style.marginTop = '6px';
  element.textContent = text;
  return element;
}

function muted(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'small muted';
  element.textContent = text;
  return element;
}

function labeled(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.style.display = 'block';
  wrapper.style.marginTop = '8px';
  const caption = document.createElement('div');
  caption.className = 'tiny muted';
  caption.textContent = label;
  wrapper.append(caption, control);
  return wrapper;
}

function keyValue(rows: Array<[string, string]>): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'kv';
  for (const [key, value] of rows) {
    const tr = document.createElement('tr');
    const tdKey = document.createElement('td');
    tdKey.textContent = key;
    const tdValue = document.createElement('td');
    tdValue.textContent = value;
    tr.append(tdKey, tdValue);
    table.appendChild(tr);
  }
  return table;
}
