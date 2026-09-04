import { axisBottom } from 'd3-axis';
import { drag } from 'd3-drag';
import { scaleLinear, type ScaleLinear } from 'd3-scale';
import { select } from 'd3-selection';
import { addSnapshot, deleteSnapshot, updateSnapshot, addEvent } from '../state/edits';
import { formatDate, snapshotAt, sortedSnapshots, timeExtent, toNumericDate } from '../state/time';
import type { World } from '../state/types';
import { setStatus, uiStore } from '../state/ui';
import { worldStore } from '../state/world';
import { confirmDialog, openForm } from '../ui/dialog';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD_X = 60;

/** Единая точка изменения текущего момента времени. */
export function setTime(time: number): void {
  const world = worldStore.get();
  const snapshot = snapshotAt(world.timeline.snapshots, time);
  uiStore.update((state) => {
    state.time = time;
    state.activeSnapshotId = snapshot?.id ?? null;
  });
}

/** Перейти к эпохе (snapshot) по id. */
export function gotoSnapshot(id: string): void {
  const world = worldStore.get();
  const snapshot = world.timeline.snapshots.find((item) => item.id === id);
  if (snapshot) setTime(toNumericDate(snapshot.date));
}

export class TimelineView {
  private toolbar: HTMLDivElement;
  private wrap: HTMLDivElement;
  private svg: SVGSVGElement;
  private scale: ScaleLinear<number, number> = scaleLinear();
  private width = 0;
  private height = 0;
  private nowLabel: HTMLSpanElement;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement) {
    this.toolbar = document.createElement('div');
    this.toolbar.id = 'timeline-toolbar';
    container.appendChild(this.toolbar);

    this.wrap = document.createElement('div');
    this.wrap.id = 'timeline-svg-wrap';
    container.appendChild(this.wrap);

    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.wrap.appendChild(this.svg);

    this.nowLabel = document.createElement('span');
    this.nowLabel.className = 'now';
    this.buildToolbar();

    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.wrap);

    worldStore.subscribe(() => this.render());
    uiStore.subscribe(() => this.render());
    this.render();
  }

  private button(label: string, title: string, onClick: () => void, className = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = label;
    button.title = title;
    if (className) button.className = className;
    button.addEventListener('click', onClick);
    return button;
  }

  private buildToolbar(): void {
    this.toolbar.append(
      this.button('◀', 'Предыдущая эпоха', () => this.step(-1), 'icon'),
      this.button('▶', 'Следующая эпоха', () => this.step(1), 'icon'),
      this.nowLabel,
      this.button('+ Эпоха', 'Добавить snapshot на текущей дате (копия предыдущего)', () => this.addSnapshotDialog()),
      this.button('Правка', 'Изменить дату/название текущей эпохи', () => this.editSnapshotDialog()),
      this.button('Удалить', 'Удалить текущую эпоху', () => this.removeSnapshot(), 'danger'),
      this.button('+ Событие', 'Добавить событие на текущей дате', () => this.addEventDialog()),
    );
  }

  private step(direction: -1 | 1): void {
    const world = worldStore.get();
    const snapshots = sortedSnapshots(world.timeline.snapshots);
    if (snapshots.length === 0) return;
    const time = uiStore.get().time;
    const current = snapshotAt(snapshots, time);
    const index = current ? snapshots.findIndex((item) => item.id === current.id) : 0;
    const next = snapshots[Math.min(snapshots.length - 1, Math.max(0, index + direction))];
    if (next) setTime(toNumericDate(next.date));
  }

  private async addSnapshotDialog(): Promise<void> {
    const ui = uiStore.get();
    const result = await openForm({
      title: 'Новая эпоха',
      submitLabel: 'Добавить',
      fields: [
        { name: 'date', label: 'Дата (число или строка своей эры)', value: String(Math.round(ui.time)) },
        { name: 'label', label: 'Название', placeholder: 'Например: Раскол Империи' },
      ],
    });
    if (!result) return;
    addSnapshot(result.date, result.label);
    setTime(toNumericDate(result.date));
  }

  private async editSnapshotDialog(): Promise<void> {
    const world = worldStore.get();
    const snapshot = snapshotAt(world.timeline.snapshots, uiStore.get().time);
    if (!snapshot) {
      setStatus('Нет ни одной эпохи — сначала добавьте её');
      return;
    }
    const result = await openForm({
      title: 'Эпоха',
      fields: [
        { name: 'date', label: 'Дата', value: snapshot.date },
        { name: 'label', label: 'Название', value: snapshot.label ?? '' },
        { name: 'notes', label: 'Заметки', type: 'textarea', value: snapshot.notes ?? '' },
      ],
    });
    if (!result) return;
    updateSnapshot(snapshot.id, { date: result.date, label: result.label, notes: result.notes });
    setTime(toNumericDate(result.date));
  }

  private removeSnapshot(): void {
    const world = worldStore.get();
    const snapshot = snapshotAt(world.timeline.snapshots, uiStore.get().time);
    if (!snapshot) return;
    if (!confirmDialog(`Удалить эпоху «${snapshot.label ?? snapshot.date}»?`)) return;
    deleteSnapshot(snapshot.id);
  }

  private async addEventDialog(): Promise<void> {
    const ui = uiStore.get();
    const world = worldStore.get();
    const selectedRegion = ui.selection?.kind === 'region' ? ui.selection.id : '';
    const result = await openForm({
      title: 'Новое событие',
      submitLabel: 'Добавить',
      fields: [
        { name: 'date', label: 'Дата', value: String(Math.round(ui.time)) },
        { name: 'title', label: 'Название', placeholder: 'Основание Первой Империи' },
        { name: 'description', label: 'Описание', type: 'textarea' },
        {
          name: 'regionId',
          label: 'Привязка к региону (необязательно)',
          type: 'select',
          value: selectedRegion,
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
    if (!result || !result.title.trim()) return;
    addEvent({
      date: result.date,
      title: result.title.trim(),
      description: result.description || undefined,
      regionId: result.regionId || undefined,
    });
    setStatus(`Событие «${result.title}» добавлено`);
  }

  /* ------------------------------ отрисовка ------------------------------ */

  private render(): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    const rect = this.wrap.getBoundingClientRect();
    this.width = Math.max(200, Math.round(rect.width));
    this.height = Math.max(60, Math.round(rect.height));
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);

    const extent = timeExtent(world.timeline.snapshots, world.timeline.events);
    this.scale = scaleLinear().domain([extent.min, extent.max]).range([PAD_X, this.width - PAD_X]);

    const snapshot = snapshotAt(world.timeline.snapshots, ui.time);
    this.nowLabel.textContent = `${formatDate(ui.time, world.meta.era)}${snapshot?.label ? ` · ${snapshot.label}` : ''}`;

    this.svg.replaceChildren();

    const snapshotY = 26;
    const eventY = 52;
    const axisY = this.height - 20;

    // дорожка
    const track = document.createElementNS(SVG_NS, 'rect');
    track.setAttribute('class', 'tl-track');
    track.setAttribute('x', String(PAD_X - 6));
    track.setAttribute('y', String(snapshotY - 6));
    track.setAttribute('width', String(this.width - PAD_X * 2 + 12));
    track.setAttribute('height', '14');
    track.setAttribute('rx', '4');
    this.svg.appendChild(track);

    // зона клика по всей шкале
    const hitzone = document.createElementNS(SVG_NS, 'rect');
    hitzone.setAttribute('class', 'tl-hitzone');
    hitzone.setAttribute('x', '0');
    hitzone.setAttribute('y', '0');
    hitzone.setAttribute('width', String(this.width));
    hitzone.setAttribute('height', String(axisY));
    hitzone.addEventListener('click', (event) => {
      const bounds = this.svg.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * this.width;
      setTime(this.clampTime(this.scale.invert(x)));
    });
    this.svg.appendChild(hitzone);

    // эпохи
    for (const item of sortedSnapshots(world.timeline.snapshots)) {
      const x = this.scale(toNumericDate(item.date));
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', `tl-snap${snapshot?.id === item.id ? ' active' : ''}`);
      group.style.cursor = 'pointer';

      const bar = document.createElementNS(SVG_NS, 'rect');
      bar.setAttribute('x', String(x - 3));
      bar.setAttribute('y', String(snapshotY - 5));
      bar.setAttribute('width', '6');
      bar.setAttribute('height', '12');
      bar.setAttribute('rx', '2');
      group.appendChild(bar);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(snapshotY - 10));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = item.label ?? item.date;
      group.appendChild(label);

      group.addEventListener('click', (event) => {
        event.stopPropagation();
        setTime(toNumericDate(item.date));
      });
      this.svg.appendChild(group);
    }

    // события
    for (const event of world.timeline.events) {
      const x = this.scale(toNumericDate(event.date));
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', `tl-event${ui.selectedEventId === event.id ? ' selected' : ''}`);

      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(eventY));
      dot.setAttribute('r', '4');
      group.appendChild(dot);

      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${event.date} — ${event.title}`;
      group.appendChild(title);

      group.addEventListener('click', (nativeEvent) => {
        nativeEvent.stopPropagation();
        uiStore.update((state) => {
          state.selectedEventId = event.id;
        });
        setTime(toNumericDate(event.date));
      });
      this.svg.appendChild(group);
    }

    // ось
    const axisGroup = document.createElementNS(SVG_NS, 'g');
    axisGroup.setAttribute('class', 'tl-axis');
    axisGroup.setAttribute('transform', `translate(0,${axisY})`);
    this.svg.appendChild(axisGroup);
    select(axisGroup).call(
      axisBottom(this.scale)
        .ticks(Math.max(3, Math.floor(this.width / 110)))
        .tickFormat((value) => formatDate(Number(value), world.meta.era)),
    );

    // ползунок текущего момента
    const handleX = this.scale(ui.time);
    const handle = document.createElementNS(SVG_NS, 'g');
    handle.setAttribute('class', 'tl-handle');
    handle.setAttribute('transform', `translate(${handleX},0)`);

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '6');
    line.setAttribute('x2', '0');
    line.setAttribute('y2', String(axisY));
    handle.appendChild(line);

    const grip = document.createElementNS(SVG_NS, 'rect');
    grip.setAttribute('x', '-6');
    grip.setAttribute('y', '0');
    grip.setAttribute('width', '12');
    grip.setAttribute('height', '10');
    grip.setAttribute('rx', '3');
    handle.appendChild(grip);
    this.svg.appendChild(handle);

    select(handle).call(
      drag<SVGGElement, unknown>().on('drag', (event) => {
        const bounds = this.svg.getBoundingClientRect();
        const x = ((event.sourceEvent.clientX - bounds.left) / bounds.width) * this.width;
        setTime(this.clampTime(this.scale.invert(x)));
      }),
    );
  }

  private clampTime(value: number): number {
    const [min, max] = this.scale.domain();
    return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
  }
}
