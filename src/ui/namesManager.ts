/**
 * Менеджер названий: правка имён всех сущностей мира «на всю карту», плюс
 * история переименований и переходы (язык -> язык, империя -> республика).
 */
import {
  listEntities,
  renameEntity,
  replaceInNames,
  setEntityColor,
  setNameHistory,
  setSuccessions,
  type EntityKind,
  type NamedEntity,
} from '../state/edits';
import { nameAt } from '../state/naming';
import type { NameChange, Succession } from '../state/types';
import { setStatus, uiStore } from '../state/ui';
import { worldStore } from '../state/world';

const TABS: Array<{ kind: EntityKind; label: string; colors: boolean; successions: boolean }> = [
  { kind: 'states', label: 'Государства', colors: true, successions: true },
  { kind: 'regions', label: 'Регионы', colors: false, successions: false },
  { kind: 'cultures', label: 'Культуры', colors: true, successions: true },
  { kind: 'religions', label: 'Религии', colors: true, successions: true },
  { kind: 'languages', label: 'Языки', colors: true, successions: true },
  { kind: 'burgs', label: 'Города', colors: false, successions: false },
  { kind: 'markers', label: 'Метки', colors: false, successions: false },
];

let styleInjected = false;

function injectStyles(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .nm-backdrop { position: fixed; inset: 0; background: rgba(6,9,14,.66); display: grid; place-items: center; z-index: 120; }
    .nm { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px;
          width: min(880px, 94vw); height: min(640px, 88vh); display: flex; flex-direction: column;
          box-shadow: 0 22px 60px rgba(0,0,0,.55); }
    .nm header { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .nm header h2 { margin: 0; font-size: 15px; }
    .nm .tabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--line); }
    .nm .tools { display: flex; gap: 6px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .nm .tools input[type="text"] { width: auto; min-width: 130px; }
    .nm .rows { flex: 1; overflow-y: auto; padding: 8px 12px 14px; }
    .nm-row { border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; background: var(--bg-panel-2); }
    .nm-row + .nm-row { margin-top: 6px; }
    .nm-row .main { display: flex; align-items: center; gap: 7px; }
    .nm-row .main input[type="text"] { flex: 1; }
    .nm-row .main input[type="color"] { width: 22px; height: 22px; padding: 0; border: none; background: none; flex: none; cursor: pointer; }
    .nm-row .now { color: var(--text-dim); font-size: 11px; white-space: nowrap; }
    .nm-sub { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line); }
    .nm-sub .line { display: flex; gap: 6px; align-items: center; }
    .nm-sub .line + .line { margin-top: 4px; }
    .nm-sub .line input[type="text"] { width: 90px; }
    .nm-sub .line input.grow, .nm-sub .line select { flex: 1; }
    .nm-empty { color: var(--text-dim); font-size: 12px; padding: 12px 0; }
  `;
  document.head.appendChild(style);
}

interface ManagerState {
  kind: EntityKind;
  filter: string;
  expanded: Set<string>;
}

export function openNamesManager(initial: EntityKind = 'states'): void {
  injectStyles();

  const state: ManagerState = { kind: initial, filter: '', expanded: new Set() };

  const backdrop = document.createElement('div');
  backdrop.className = 'nm-backdrop';
  const panel = document.createElement('div');
  panel.className = 'nm';
  backdrop.appendChild(panel);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
    unsubscribe();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeyDown);

  const render = (): void => {
    const world = worldStore.get();
    const time = uiStore.get().time;
    const tab = TABS.find((item) => item.kind === state.kind)!;
    panel.replaceChildren();

    /* --- заголовок --- */
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = 'Названия и переходы';
    const hint = document.createElement('div');
    hint.className = 'tiny muted grow';
    hint.textContent = 'Имя действует всегда; переименование — с указанной даты; переход подменяет сущность целиком.';
    const closeButton = button('Закрыть', close);
    header.append(title, hint, closeButton);
    panel.appendChild(header);

    /* --- вкладки --- */
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const item of TABS) {
      const count = listEntities(world, item.kind).length;
      tabs.appendChild(
        button(
          `${item.label} (${count})`,
          () => {
            state.kind = item.kind;
            state.expanded.clear();
            render();
          },
          state.kind === item.kind ? 'primary' : '',
        ),
      );
    }
    panel.appendChild(tabs);

    /* --- поиск и массовая замена --- */
    const tools = document.createElement('div');
    tools.className = 'tools';

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = 'Фильтр по названию…';
    filter.value = state.filter;
    filter.addEventListener('input', () => {
      state.filter = filter.value;
      renderRows();
    });

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'найти';
    const replacement = document.createElement('input');
    replacement.type = 'text';
    replacement.placeholder = 'заменить на';

    tools.append(
      filter,
      document.createTextNode('·'),
      search,
      replacement,
      button('Заменить во всех', () => {
        if (!search.value) {
          setStatus('Укажите, что искать');
          return;
        }
        replaceInNames(state.kind, search.value, replacement.value);
        render();
      }),
    );
    panel.appendChild(tools);

    /* --- строки --- */
    const rows = document.createElement('div');
    rows.className = 'rows';
    panel.appendChild(rows);

    const renderRows = (): void => {
      const query = state.filter.trim().toLowerCase();
      const entities = listEntities(worldStore.get(), state.kind).filter(
        (entity) => !query || entity.name.toLowerCase().includes(query),
      );
      rows.replaceChildren();

      if (entities.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'nm-empty';
        empty.textContent = 'Ничего не найдено.';
        rows.appendChild(empty);
        return;
      }

      for (const entity of entities.slice(0, 400)) {
        rows.appendChild(renderRow(entity, tab, time));
      }
      if (entities.length > 400) {
        const more = document.createElement('div');
        more.className = 'nm-empty';
        more.textContent = `Показаны первые 400 из ${entities.length} — уточните фильтр.`;
        rows.appendChild(more);
      }
    };

    const renderRow = (
      entity: NamedEntity,
      config: (typeof TABS)[number],
      currentTime: number,
    ): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'nm-row';

      const main = document.createElement('div');
      main.className = 'main';

      if (config.colors) {
        const color = document.createElement('input');
        color.type = 'color';
        color.value = /^#[0-9a-f]{6}$/i.test(entity.color ?? '') ? entity.color! : '#888888';
        color.addEventListener('change', () => setEntityColor(state.kind, entity.id, color.value));
        main.appendChild(color);
      }

      const name = document.createElement('input');
      name.type = 'text';
      name.value = entity.name;
      name.addEventListener('change', () => {
        if (name.value.trim()) renameEntity(state.kind, entity.id, name.value.trim());
      });
      main.appendChild(name);

      const currentName = nameAt(entity, currentTime);
      if (currentName !== entity.name) {
        const now = document.createElement('span');
        now.className = 'now';
        now.textContent = `сейчас: ${currentName}`;
        main.appendChild(now);
      }

      const historyCount = entity.names?.length ?? 0;
      main.appendChild(
        button(
          `⏱${historyCount ? ` ${historyCount}` : ''}`,
          () => {
            if (state.expanded.has(entity.id)) state.expanded.delete(entity.id);
            else state.expanded.add(entity.id);
            renderRows();
          },
          state.expanded.has(entity.id) ? 'primary icon' : 'icon',
          'Переименования во времени',
        ),
      );
      row.appendChild(main);

      if (state.expanded.has(entity.id)) {
        row.appendChild(renderHistory(entity, config));
      }
      return row;
    };

    const renderHistory = (entity: NamedEntity, config: (typeof TABS)[number]): HTMLElement => {
      const wrapper = document.createElement('div');
      wrapper.className = 'nm-sub';

      const caption = document.createElement('div');
      caption.className = 'tiny muted';
      caption.textContent = 'Переименования: с указанной даты действует новое имя';
      wrapper.appendChild(caption);

      const changes: NameChange[] = [...(entity.names ?? [])];
      for (const [index, change] of changes.entries()) {
        const line = document.createElement('div');
        line.className = 'line';
        const date = document.createElement('input');
        date.type = 'text';
        date.value = change.date;
        const value = document.createElement('input');
        value.type = 'text';
        value.className = 'grow';
        value.value = change.name;
        const save = (): void => {
          const next = changes.map((item, itemIndex) =>
            itemIndex === index ? { date: date.value, name: value.value } : item,
          );
          setNameHistory(state.kind, entity.id, next);
        };
        date.addEventListener('change', save);
        value.addEventListener('change', save);
        line.append(
          date,
          value,
          button(
            '✕',
            () => {
              setNameHistory(
                state.kind,
                entity.id,
                changes.filter((_item, itemIndex) => itemIndex !== index),
              );
              renderRows();
            },
            'icon danger',
          ),
        );
        wrapper.appendChild(line);
      }

      const addLine = document.createElement('div');
      addLine.className = 'line';
      const newDate = document.createElement('input');
      newDate.type = 'text';
      newDate.placeholder = 'дата';
      newDate.value = String(Math.round(uiStore.get().time));
      const newName = document.createElement('input');
      newName.type = 'text';
      newName.className = 'grow';
      newName.placeholder = 'новое имя с этой даты';
      addLine.append(
        newDate,
        newName,
        button('+', () => {
          if (!newName.value.trim()) return;
          setNameHistory(state.kind, entity.id, [
            ...changes,
            { date: newDate.value || '0', name: newName.value.trim() },
          ]);
          renderRows();
        }, 'icon'),
      );
      wrapper.appendChild(addLine);

      if (config.successions) {
        const successionCaption = document.createElement('div');
        successionCaption.className = 'tiny muted';
        successionCaption.style.marginTop = '8px';
        successionCaption.textContent = 'Переходы: с даты вместо этой сущности показывается другая';
        wrapper.appendChild(successionCaption);

        const others = listEntities(worldStore.get(), state.kind).filter((item) => item.id !== entity.id);
        const list: Succession[] = [...(entity.succeededBy ?? [])];

        for (const [index, step] of list.entries()) {
          const line = document.createElement('div');
          line.className = 'line';
          const date = document.createElement('input');
          date.type = 'text';
          date.value = step.date;
          const target = document.createElement('select');
          for (const other of others) {
            const option = document.createElement('option');
            option.value = other.id;
            option.textContent = other.name;
            target.appendChild(option);
          }
          target.value = step.toId;
          const save = (): void => {
            const next = list.map((item, itemIndex) =>
              itemIndex === index ? { date: date.value, toId: target.value } : item,
            );
            setSuccessions(state.kind, entity.id, next);
          };
          date.addEventListener('change', save);
          target.addEventListener('change', save);
          line.append(
            date,
            target,
            button(
              '✕',
              () => {
                setSuccessions(
                  state.kind,
                  entity.id,
                  list.filter((_item, itemIndex) => itemIndex !== index),
                );
                renderRows();
              },
              'icon danger',
            ),
          );
          wrapper.appendChild(line);
        }

        if (others.length > 0) {
          const addSuccession = document.createElement('div');
          addSuccession.className = 'line';
          const date = document.createElement('input');
          date.type = 'text';
          date.placeholder = 'дата';
          date.value = String(Math.round(uiStore.get().time));
          const target = document.createElement('select');
          for (const other of others) {
            const option = document.createElement('option');
            option.value = other.id;
            option.textContent = other.name;
            target.appendChild(option);
          }
          addSuccession.append(
            date,
            target,
            button('+', () => {
              setSuccessions(state.kind, entity.id, [...list, { date: date.value || '0', toId: target.value }]);
              renderRows();
            }, 'icon'),
          );
          wrapper.appendChild(addSuccession);
        }
      }

      return wrapper;
    };

    renderRows();
  };

  // мир может меняться из других панелей — перерисовываемся
  const unsubscribe = worldStore.subscribe(() => {
    if (document.body.contains(backdrop)) render();
  });

  render();
  document.body.appendChild(backdrop);
}

function button(label: string, onClick: () => void, className = '', title = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  if (className) element.className = className;
  if (title) element.title = title;
  element.addEventListener('click', onClick);
  return element;
}
