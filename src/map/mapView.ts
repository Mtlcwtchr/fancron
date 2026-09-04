import { geoContains, geoPath, type GeoPath, type GeoProjection } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import type { Feature, Geometry, Position } from 'geojson';
import { applyHeightBrush, applyPaint, beginPaintSession, cellsInRadius, endPaintSession } from '../state/paint';
import { addBurg, addMarker, addRoute, movePoint } from '../state/edits';
import { findPath } from '../util/path';
import { effectiveProperties, effectiveRegionId, overridesAt } from '../state/geoOverrides';
import { nameAt, pointVisibleAt, regionNameAt, resolveStateId, stateAt } from '../state/naming';
import { regionGeometries, topologyOf } from '../state/topology';
import type { RegionProperties, WindVector, World } from '../state/types';
import { toNumericDate } from '../state/time';
import { setStatus, uiStore, type UiState } from '../state/ui';
import { beginStroke, endStroke, mutateWorld, regionOwnershipAt, worldStore } from '../state/world';
import {
  buildPolygonLayers,
  cultureColor,
  heightExtent,
  languageColor,
  religionColor,
  seaLevelOf,
  stateColor,
  type AnyFeature,
  type PolygonLayer,
} from './layers';
import { biomeColor as biomeColorOfRaw, heightColor } from './colors';

const biomeColorOf = (biome: unknown): string => biomeColorOfRaw(biome as string | undefined);
import { fitProjection, makeProjection } from './projection';
import { windVectorAt } from '../util/wind';

/** Выше этого числа фич слой рисуется на canvas, ниже — обычными SVG-путями. */
const SVG_FEATURE_LIMIT = 1500;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface ScreenItem {
  px: number;
  py: number;
  apply: (x: number, y: number) => void;
  hide: (hidden: boolean) => void;
  /** элемент показывается только начиная с этого масштаба — так карта не зарастает подписями */
  minScale?: number;
}

interface VertexRef {
  ringIndex: number;
  pointIndex: number;
}

export class MapView {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** ветра рисуются поверх слоёв: под SVG-областями их просто не видно */
  private windCanvas: HTMLCanvasElement;
  private windCtx: CanvasRenderingContext2D;
  private svg: SVGSVGElement;
  private root: SVGGElement;
  private layersGroup: SVGGElement;
  private liveGroup: SVGGElement;
  private hoverPath: SVGPathElement;
  private selectPath: SVGPathElement;
  private overlayGroup: SVGGElement;
  private handlesGroup: SVGGElement;
  private brushRing: SVGCircleElement;
  private tooltip: HTMLDivElement;

  private projection: GeoProjection = makeProjection('equirectangular');
  private path: GeoPath = geoPath(this.projection);
  private transform: ZoomTransform = zoomIdentity;
  private zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

  private width = 0;
  private height = 0;
  private layers: PolygonLayer[] = [];
  private screenItems: ScreenItem[] = [];
  private dataBounds: [[number, number], [number, number]] | null = null;
  private fitKey = '';
  private renderQueued = false;
  private transformQueued = false;
  private painting = false;
  private draggingVertex: VertexRef | null = null;
  private draggingPoint: { kind: 'burg' | 'marker'; id: string } | null = null;
  /** черновик маршрута: опорные ячейки и полный путь между ними */
  private routeDraft: { waypoints: string[]; cells: string[] } | null = null;
  private routePath: SVGPathElement;
  private unsubscribes: Array<() => void> = [];
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;

    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    container.appendChild(this.svg);

    this.root = document.createElementNS(SVG_NS, 'g');
    this.svg.appendChild(this.root);
    this.layersGroup = document.createElementNS(SVG_NS, 'g');
    this.root.appendChild(this.layersGroup);

    // мазок кисти рисуется сразу поверх слоёв: полноценный перерасчёт границ
    // делается один раз, когда кисть отпущена
    this.liveGroup = document.createElementNS(SVG_NS, 'g');
    this.liveGroup.setAttribute('class', 'live-paint');
    this.root.appendChild(this.liveGroup);

    this.hoverPath = document.createElementNS(SVG_NS, 'path');
    this.hoverPath.setAttribute('class', 'region-outline hover');
    this.root.appendChild(this.hoverPath);

    this.selectPath = document.createElementNS(SVG_NS, 'path');
    this.selectPath.setAttribute('class', 'region-outline');
    this.root.appendChild(this.selectPath);

    // черновик маршрута рисуется поверх слоёв, пока путь не зафиксирован
    this.routePath = document.createElementNS(SVG_NS, 'path');
    this.routePath.setAttribute('class', 'route-draft');
    this.root.appendChild(this.routePath);

    // точки, подписи, ручки вершин и круг кисти живут вне трансформа,
    // чтобы не масштабировать глифы вместе с картой
    this.overlayGroup = document.createElementNS(SVG_NS, 'g');
    this.svg.appendChild(this.overlayGroup);
    this.handlesGroup = document.createElementNS(SVG_NS, 'g');
    this.svg.appendChild(this.handlesGroup);

    this.brushRing = document.createElementNS(SVG_NS, 'circle');
    this.brushRing.setAttribute('class', 'brush-ring');
    this.brushRing.style.display = 'none';
    this.svg.appendChild(this.brushRing);

    this.windCanvas = document.createElement('canvas');
    this.windCanvas.className = 'wind-canvas';
    container.appendChild(this.windCanvas);
    this.windCtx = this.windCanvas.getContext('2d')!;

    this.tooltip = document.createElement('div');
    this.tooltip.id = 'tooltip';
    container.appendChild(this.tooltip);

    this.zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 200])
      .filter((event: MouseEvent | WheelEvent | TouchEvent) => {
        if (event.type === 'wheel' || event.type.startsWith('touch')) return true;
        const tool = uiStore.get().tool;
        const mouse = event as MouseEvent;
        if (tool === 'select') return mouse.button === 0 || mouse.button === 1;
        // в режимах правки левая кнопка занята инструментом: пан — средней или с Shift
        return mouse.button === 1 || mouse.shiftKey;
      })
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        this.transform = event.transform;
        this.scheduleTransform();
      });
    select(this.svg).call(this.zoomBehavior);

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
    this.svg.addEventListener('pointerleave', this.onPointerLeave);
    this.svg.addEventListener('click', this.onClick);

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(container);
    this.measure();

    this.unsubscribes.push(worldStore.subscribe(() => this.scheduleRender()));
    this.unsubscribes.push(uiStore.subscribe(() => this.scheduleRender()));
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('pointercancel', this.onPointerUp);
    this.svg.removeEventListener('pointerleave', this.onPointerLeave);
    this.svg.removeEventListener('click', this.onClick);
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  /* --------------------------- размеры и проекция --------------------------- */

  private measure(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.windCanvas.width = this.canvas.width;
    this.windCanvas.height = this.canvas.height;
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.scheduleRender();
  }

  private ensureProjection(world: World): void {
    const key = [
      world.meta.projection ?? 'equirectangular',
      world.cells.features.length,
      world.regions.features.length,
      world.points.burgs.length,
      this.width,
      this.height,
    ].join('|');
    if (key === this.fitKey) return;
    this.fitKey = key;
    this.projection = makeProjection(world.meta.projection);
    const source =
      world.cells.features.length > 0
        ? world.cells
        : world.regions.features.length > 0
          ? world.regions
          : null;
    fitProjection(this.projection, source as never, this.width, this.height);
    this.path = geoPath(this.projection);
    this.dataBounds = source ? (this.path.bounds(source as never) as [[number, number], [number, number]]) : null;
  }

  /** Пересчитать проекцию под данные и сбросить зум. */
  fit(): void {
    this.fitKey = '';
    this.transform = zoomIdentity;
    select(this.svg).call(this.zoomBehavior.transform, zoomIdentity);
    this.scheduleRender();
  }

  zoomBy(factor: number): void {
    this.zoomBehavior.scaleBy(select(this.svg), factor);
  }

  /* --------------------------- рендер --------------------------- */

  private scheduleRender(): void {
    // во время мазка карта обновляется дельтой, полный пересчёт — по отпусканию кисти
    if (this.painting) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private scheduleTransform(): void {
    if (this.transformQueued) return;
    this.transformQueued = true;
    requestAnimationFrame(() => {
      this.transformQueued = false;
      this.applyTransform();
    });
  }

  private render(): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    this.ensureProjection(world);
    this.layers = buildPolygonLayers(world, ui, { fast: this.painting });

    this.svg.classList.toggle('tool-paint', ui.tool === 'paint' || ui.tool === 'height');
    this.svg.classList.toggle('tool-vertices', ui.tool === 'vertices');

    this.layersGroup.replaceChildren();
    for (const layer of this.layers) {
      if (layer.features.length > SVG_FEATURE_LIMIT) continue;
      const group = document.createElementNS(SVG_NS, 'g');
      group.dataset.layer = layer.id;
      if (layer.opacity !== undefined) group.setAttribute('opacity', String(layer.opacity));
      for (const feature of layer.features) {
        const fill = layer.fill(feature);
        const stroke = layer.strokeOf ? layer.strokeOf(feature) : layer.stroke;
        if (!fill && !stroke) continue;
        const d = this.path(feature as never);
        if (!d) continue;
        const element = document.createElementNS(SVG_NS, 'path');
        element.setAttribute('class', 'map-path');
        element.setAttribute('d', d);
        element.setAttribute('fill', fill ?? 'none');
        if (stroke) {
          element.setAttribute('stroke', stroke);
          element.setAttribute('stroke-width', String(layer.widthOf ? layer.widthOf(feature) : layer.strokeWidth ?? 0.5));
          const dash = layer.dashOf ? layer.dashOf(feature) : layer.dash;
          if (dash) element.setAttribute('stroke-dasharray', dash);
          element.setAttribute('stroke-linejoin', 'round');
          element.setAttribute('stroke-linecap', 'round');
        }
        group.appendChild(element);
      }
      this.layersGroup.appendChild(group);
    }

    this.liveGroup.replaceChildren();
    this.renderOverlay(world, ui);
    this.renderVertexHandles(world, ui);
    this.renderRouteDraft();
    this.applyTransform();
    this.updateOutlines(world, ui);
  }

  /** Точки и подписи (вне трансформа). */
  private renderOverlay(world: World, ui: UiState): void {
    this.overlayGroup.replaceChildren();
    this.screenItems = [];

    if (ui.layers.states && ui.labels && world.timeline.states.length > 0) {
      for (const [stateId, anchor, pieceWidth] of this.stateLabelAnchors(world, ui)) {
        const state = stateAt(world, stateId, ui.time);
        if (!state) continue;
        const textWidth = state.name.length * 6.4;
        const minScale = pieceWidth > 0 ? Math.max(0.2, textWidth / pieceWidth) : 0.2;
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('class', 'point-label');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '12');
        text.setAttribute('font-weight', '600');
        text.textContent = state.name;
        this.overlayGroup.appendChild(text);
        this.screenItems.push({
          px: anchor[0],
          py: anchor[1],
          minScale,
          apply: (x, y) => {
            text.setAttribute('x', String(x));
            text.setAttribute('y', String(y));
          },
          hide: (hidden) => {
            text.style.display = hidden ? 'none' : '';
          },
        });
      }
    }

    if (ui.layers.burgs) {
      for (const burg of world.points.burgs) {
        // город существует не всегда: основан в таком-то году, разрушен в таком-то
        if (!pointVisibleAt(burg, ui.time)) continue;
        const projected = this.projection([burg.x, burg.y]);
        if (!projected) continue;
        const radius = burg.capital ? 4 : 2.2 + Math.log10((burg.population ?? 0) + 1) * 0.4;
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('class', burg.capital ? 'burg capital' : 'burg');
        circle.setAttribute('r', String(Math.min(7, Math.max(1.8, radius))));
        circle.setAttribute('fill', stateColor(world, burg.stateId) ?? '#e8eef8');
        circle.dataset.kind = 'burg';
        circle.dataset.id = burg.id;
        this.overlayGroup.appendChild(circle);

        let label: SVGTextElement | null = null;
        if (ui.labels && (burg.capital || this.transform.k > 3)) {
          label = document.createElementNS(SVG_NS, 'text');
          label.setAttribute('class', 'point-label');
          label.setAttribute('text-anchor', 'middle');
          label.textContent = nameAt(burg, ui.time);
          this.overlayGroup.appendChild(label);
        }

        this.screenItems.push({
          px: projected[0],
          py: projected[1],
          minScale: burg.capital ? undefined : (burg.population ?? 0) > 5000 ? 1.4 : 2.2,
          apply: (x, y) => {
            circle.setAttribute('cx', String(x));
            circle.setAttribute('cy', String(y));
            if (label) {
              label.setAttribute('x', String(x));
              label.setAttribute('y', String(y - 6));
            }
          },
          hide: (hidden) => {
            circle.style.display = hidden ? 'none' : '';
            if (label) label.style.display = hidden ? 'none' : '';
          },
        });
      }
    }

    if (ui.layers.markers) {
      for (const marker of world.points.markers) {
        if (!pointVisibleAt(marker, ui.time)) continue;
        const projected = this.projection([marker.x, marker.y]);
        if (!projected) continue;
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('class', 'marker-pin');
        text.setAttribute('text-anchor', 'middle');
        text.textContent = marker.icon || '◆';
        text.dataset.kind = 'marker';
        text.dataset.id = marker.id;
        this.overlayGroup.appendChild(text);
        this.screenItems.push({
          px: projected[0],
          py: projected[1],
          apply: (x, y) => {
            text.setAttribute('x', String(x));
            text.setAttribute('y', String(y + 4));
          },
          hide: (hidden) => {
            text.style.display = hidden ? 'none' : '';
          },
        });
      }
    }
  }

  /** Подпись государства ставим в его крупнейшей области. */
  private stateLabelAnchors(world: World, ui: UiState): Array<[string, [number, number], number]> {
    const layer = this.layers.find((item) => item.id === 'states');
    const anchors: Array<[string, [number, number], number]> = [];
    if (!layer) return anchors;

    if (layer.kind === 'area') {
      for (const feature of layer.features) {
        const piece = this.largestPieceCentroid(feature);
        if (piece) anchors.push([String(feature.properties.id), piece.centroid, piece.width]);
      }
      return anchors;
    }

    // «быстрый» режим во время мазка: подписи по регионам
    const ownership = regionOwnershipAt(world, ui.time);
    const best = new Map<string, { area: number; centroid: [number, number] }>();
    for (const feature of world.regions.features) {
      const owner = ownership.get(feature.properties.id);
      if (!owner) continue;
      const area = Math.abs(this.path.area(feature as never));
      const previous = best.get(owner);
      if (previous && previous.area >= area) continue;
      const [cx, cy] = this.path.centroid(feature as never);
      if (Number.isFinite(cx) && Number.isFinite(cy)) best.set(owner, { area, centroid: [cx, cy] });
    }
    for (const [stateId, entry] of best) anchors.push([stateId, entry.centroid, Math.sqrt(entry.area)]);
    return anchors;
  }

  /** Центроид самого большого куска MultiPolygon — чтобы подпись не улетала в океан. */
  private largestPieceCentroid(feature: AnyFeature): { centroid: [number, number]; width: number } | null {
    const geometry = feature.geometry;
    if (geometry?.type === 'MultiPolygon') {
      let bestArea = -Infinity;
      let best: { centroid: [number, number]; width: number } | null = null;
      for (const polygon of geometry.coordinates) {
        const piece = { type: 'Feature', geometry: { type: 'Polygon', coordinates: polygon }, properties: {} };
        const area = Math.abs(this.path.area(piece as never));
        if (area <= bestArea) continue;
        const [cx, cy] = this.path.centroid(piece as never);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        const bounds = this.path.bounds(piece as never);
        bestArea = area;
        best = { centroid: [cx, cy], width: bounds[1][0] - bounds[0][0] };
      }
      return best;
    }
    const [cx, cy] = this.path.centroid(feature as never);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    const bounds = this.path.bounds(feature as never);
    return { centroid: [cx, cy], width: bounds[1][0] - bounds[0][0] };
  }

  private applyTransform(): void {
    const t = this.transform;
    this.root.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    for (const item of this.screenItems) {
      const x = t.applyX(item.px);
      const y = t.applyY(item.py);
      const inView = x > -80 && x < this.width + 80 && y > -40 && y < this.height + 40;
      const bigEnough = item.minScale === undefined || t.k >= item.minScale;
      const visible = inView && bigEnough;
      item.hide(!visible);
      if (visible) item.apply(x, y);
    }
    this.positionVertexHandles();
    this.drawCanvas();
  }

  private drawCanvas(): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const t = this.transform;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);

    if (ui.layers.heightmap && world.layers.heightmap) this.drawHeightGrid(world);

    const canvasPath = geoPath(this.projection, ctx);
    const visible = this.visibleLonLatBounds();
    const boxes = world.cells.features.length > 0 ? topologyOf(world).bbox : null;
    for (const layer of this.layers) {
      if (layer.features.length <= SVG_FEATURE_LIMIT) continue;
      ctx.globalAlpha = layer.opacity ?? 1;
      const cullable = layer.kind === 'cell' && visible && boxes;
      for (const feature of layer.features) {
        if (cullable) {
          // ячейки за пределами вида не рисуем: на крупном мире это главный выигрыш
          const box = boxes!.get(String(feature.properties.id));
          if (
            box &&
            (box[2] < visible![0] || box[0] > visible![2] || box[3] < visible![1] || box[1] > visible![3])
          ) {
            continue;
          }
        }
        const fill = layer.fill(feature);
        const stroke = layer.strokeOf ? layer.strokeOf(feature) : layer.stroke;
        if (!fill && !stroke) continue;
        ctx.beginPath();
        canvasPath(feature as never);
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = (layer.widthOf ? layer.widthOf(feature) : layer.strokeWidth ?? 0.5) / t.k;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // ветра — отдельным слоем сверху
    this.windCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.windCtx.clearRect(0, 0, this.windCanvas.width, this.windCanvas.height);
    if (ui.layers.winds || ui.layers.currents) {
      this.windCtx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
      if (ui.layers.currents) this.drawCurrents(world);
      if (ui.layers.winds) this.drawWinds(world);
      this.windCtx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  /** Растровый heightmap из регулярной сетки (layers/heightmap.json). */
  private drawHeightGrid(world: World): void {
    const grid = world.layers.heightmap;
    if (!grid) return;
    const [minLon, minLat, maxLon, maxLat] = grid.bbox;
    const min = grid.min ?? Math.min(...grid.values);
    const max = grid.max ?? Math.max(...grid.values);
    const sea = seaLevelOf(world);
    const cellW = (maxLon - minLon) / grid.width;
    const cellH = (maxLat - minLat) / grid.height;
    for (let row = 0; row < grid.height; row++) {
      for (let column = 0; column < grid.width; column++) {
        const value = grid.values[row * grid.width + column];
        if (value === undefined) continue;
        const lon = minLon + column * cellW;
        const lat = maxLat - row * cellH;
        const a = this.projection([lon, lat]);
        const b = this.projection([lon + cellW, lat - cellH]);
        if (!a || !b) continue;
        this.ctx.fillStyle = heightColor(value, min, max, sea);
        this.ctx.fillRect(a[0], a[1], Math.max(0.6, b[0] - a[0]) + 0.4, Math.max(0.6, b[1] - a[1]) + 0.4);
      }
    }
  }

  /**
   * Морские течения: тёплые тянутся от экватора, холодные к нему, поэтому
   * они и раскрашены по-разному — на карте сразу видно, где тёплое побережье,
   * а где холодное с прибрежной пустыней.
   */
  private drawCurrents(world: World): void {
    const currents = world.layers.currents;
    if (!currents || currents.features.length === 0) return;
    const ctx = this.windCtx;
    const t = this.transform;

    for (const feature of currents.features) {
      const geometry = feature.geometry;
      if (geometry.type !== 'LineString') continue;
      const points = geometry.coordinates
        .map((point) => this.projection([point[0], point[1]]))
        .filter((point): point is [number, number] => Boolean(point));
      if (points.length < 3) continue;

      const warm = feature.properties.temperature !== 'cold';
      const speed = Math.min(1, Math.max(0.15, Number(feature.properties.speed ?? 0.5)));
      ctx.strokeStyle = warm
        ? `rgba(238,146,112,${(0.3 + speed * 0.35).toFixed(2)})`
        : `rgba(150,205,245,${(0.3 + speed * 0.35).toFixed(2)})`;
      ctx.lineWidth = (0.8 + speed * 1.2) / t.k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();

      // наконечник в конце линии
      const [tipX, tipY] = points[points.length - 1];
      const [prevX, prevY] = points[points.length - 2];
      const angle = Math.atan2(tipY - prevY, tipX - prevX);
      const head = 5 / t.k;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(angle - 0.4) * head, tipY - Math.sin(angle - 0.4) * head);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(angle + 0.4) * head, tipY - Math.sin(angle + 0.4) * head);
      ctx.stroke();
    }
  }

  /**
   * Поле ветров потоками, а не палочками: из каждой затравки интегрируется
   * линия тока — на каждом шаге берётся направление в текущей точке и точка
   * сдвигается по нему. Направление между широтными полосами интерполируется,
   * поэтому потоки плавно заворачивают, как настоящие пассаты и западные ветры.
   */
  private drawWinds(world: World): void {
    const winds = world.layers.winds;
    if (!winds) return;
    const ctx = this.windCtx;
    const t = this.transform;
    const equatorLat = world.meta.climate?.equatorLat ?? 0;

    const bounds = this.visibleProjectedBounds();
    if (this.dataBounds) {
      bounds[0] = Math.max(bounds[0], this.dataBounds[0][0]);
      bounds[1] = Math.max(bounds[1], this.dataBounds[0][1]);
      bounds[2] = Math.min(bounds[2], this.dataBounds[1][0]);
      bounds[3] = Math.min(bounds[3], this.dataBounds[1][1]);
    }
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return;

    // сколько градусов приходится на пиксель проекции — нужно для шага интегрирования
    const center = this.projection.invert?.([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
    if (!center) return;
    const probe = this.projection([center[0] + 1, center[1]]);
    const origin = this.projection([center[0], center[1]]);
    if (!probe || !origin) return;
    const pixelsPerDegree = Math.max(1e-6, Math.abs(probe[0] - origin[0]));
    const degreesPerPixel = 1 / pixelsPerDegree;

    const spacing = 46 / t.k;
    const steps = 14;
    const stepPixels = (spacing / 3.4) * 0.95;
    const stepDegrees = stepPixels * degreesPerPixel;

    /** Направление в точке: явные векторы или интерполированные полосы. */
    const direction = (lon: number, lat: number): [number, number] | null => {
      if (winds.vectors && winds.vectors.length > 0) {
        let best: WindVector | null = null;
        let bestDistance = Infinity;
        for (const vector of winds.vectors) {
          const distance = (vector.lon - lon) ** 2 + (vector.lat - lat) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = vector;
          }
        }
        if (!best) return null;
        const radians = (best.angle * Math.PI) / 180;
        return [Math.sin(radians), Math.cos(radians)];
      }
      return windVectorAt(winds.bands ?? [], lat, { equatorLat });
    };

    // затравки на решётке в градусах: при панораме потоки не «плывут»
    const seedStep = spacing * degreesPerPixel;
    const lonLatBounds = this.visibleLonLatBounds();
    if (!lonLatBounds) return;
    const startLon = Math.ceil(lonLatBounds[0] / seedStep) * seedStep;
    const startLat = Math.ceil(lonLatBounds[1] / seedStep) * seedStep;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let lon = startLon; lon <= lonLatBounds[2]; lon += seedStep) {
      for (let lat = startLat; lat <= lonLatBounds[3]; lat += seedStep) {
        // лёгкий детерминированный сдвиг, чтобы решётка не читалась как сетка
        const jitter = (Math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453) % 1;
        let currentLon = lon + jitter * seedStep * 0.5;
        let currentLat = lat + ((jitter * 7) % 1) * seedStep * 0.5;

        const path: Array<[number, number]> = [];
        for (let step = 0; step < steps; step++) {
          const projected = this.projection([currentLon, currentLat]);
          if (!projected) break;
          // за пределы данных не выходим: поток над пустотой только мешает
          if (
            projected[0] < bounds[0] ||
            projected[0] > bounds[2] ||
            projected[1] < bounds[1] ||
            projected[1] > bounds[3]
          ) {
            break;
          }
          path.push([projected[0], projected[1]]);
          const dir = direction(currentLon, currentLat);
          if (!dir) break;
          currentLon += dir[0] * stepDegrees;
          currentLat += dir[1] * stepDegrees;
        }
        if (path.length < 3) continue;

        // сам поток: к хвосту тоньше и прозрачнее
        for (let i = 1; i < path.length; i++) {
          const progress = i / (path.length - 1);
          ctx.strokeStyle = `rgba(214,232,255,${(0.16 + progress * 0.5).toFixed(3)})`;
          ctx.lineWidth = (0.6 + progress * 1.2) / t.k;
          ctx.beginPath();
          ctx.moveTo(path[i - 1][0], path[i - 1][1]);
          ctx.lineTo(path[i][0], path[i][1]);
          ctx.stroke();
        }

        // наконечник по последнему отрезку
        const [tipX, tipY] = path[path.length - 1];
        const [prevX, prevY] = path[path.length - 2];
        const angle = Math.atan2(tipY - prevY, tipX - prevX);
        const headLength = 5 / t.k;
        ctx.strokeStyle = 'rgba(226,240,255,0.72)';
        ctx.lineWidth = 1.1 / t.k;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - Math.cos(angle - 0.42) * headLength, tipY - Math.sin(angle - 0.42) * headLength);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - Math.cos(angle + 0.42) * headLength, tipY - Math.sin(angle + 0.42) * headLength);
        ctx.stroke();
      }
    }
  }

  /** Окно видимости в градусах — для отсечения ячеек. */
  private visibleLonLatBounds(): [number, number, number, number] | null {
    if (!this.projection.invert) return null;
    const corners: Array<[number, number]> = [
      [0, 0],
      [this.width, 0],
      [0, this.height],
      [this.width, this.height],
    ];
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const corner of corners) {
      const point = this.transform.invert(corner);
      const inverted = this.projection.invert([point[0], point[1]]);
      if (!inverted) return null;
      minLon = Math.min(minLon, inverted[0]);
      maxLon = Math.max(maxLon, inverted[0]);
      minLat = Math.min(minLat, inverted[1]);
      maxLat = Math.max(maxLat, inverted[1]);
    }
    const padLon = (maxLon - minLon) * 0.02;
    const padLat = (maxLat - minLat) * 0.02;
    return [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];
  }

  private visibleProjectedBounds(): [number, number, number, number] {
    const t = this.transform;
    const [x0, y0] = t.invert([0, 0]);
    const [x1, y1] = t.invert([this.width, this.height]);
    return [x0, y0, x1, y1];
  }

  /* --------------------------- геометрия под курсором --------------------------- */

  private lonLatAt(event: PointerEvent | MouseEvent): [number, number] | null {
    const rect = this.svg.getBoundingClientRect();
    const point = this.transform.invert([event.clientX - rect.left, event.clientY - rect.top]);
    const inverted = this.projection.invert?.([point[0], point[1]]);
    return inverted ? [inverted[0], inverted[1]] : null;
  }

  /** Радиус кисти из пикселей экрана в градусы — с учётом текущего зума. */
  private radiusInDegrees(screenRadius: number, center: [number, number]): number {
    const projected = this.projection(center);
    if (!projected) return 1;
    const shifted = this.projection.invert?.([projected[0] + screenRadius / this.transform.k, projected[1]]);
    if (!shifted) return 1;
    return Math.max(1e-4, Math.abs(shifted[0] - center[0]));
  }

  private pickCell(lonLat: [number, number]): string | null {
    const world = worldStore.get();
    if (world.cells.features.length === 0) return null;
    const topology = topologyOf(world);
    const nearest = topology.tree.find(lonLat[0], lonLat[1]);
    if (!nearest) return null;
    const feature = topology.byId.get(nearest.id);
    // сетка Voronoi: ближайший центроид почти всегда и есть нужная ячейка,
    // но для нерегулярных полигонов проверяем попадание
    if (feature && geoContains(feature as never, lonLat)) return nearest.id;
    for (const candidate of topology.neighbors.get(nearest.id) ?? []) {
      const neighbor = topology.byId.get(candidate);
      if (neighbor && geoContains(neighbor as never, lonLat)) return candidate;
    }
    return nearest.id;
  }

  private pickRegion(lonLat: [number, number]): string | null {
    const world = worldStore.get();
    if (world.meta.regionSource === 'geometry') {
      for (const feature of world.regions.features) {
        if (geoContains(feature as never, lonLat)) return feature.properties.id;
      }
      return null;
    }
    const cellId = this.pickCell(lonLat);
    if (!cellId) return null;
    const cell = topologyOf(world).byId.get(cellId);
    if (!cell) return null;
    // границы регионов зависят от эпохи, поэтому смотрим эффективную принадлежность
    return effectiveRegionId(cell, overridesAt(world, uiStore.get().time)) ?? null;
  }

  /** Геометрия региона: своя или выведенная из ячеек. */
  private regionFeature(world: World, regionId: string): Feature<Geometry, RegionProperties> | null {
    const record = world.regions.features.find((feature) => feature.properties.id === regionId);
    if (world.meta.regionSource === 'geometry') return record ?? null;
    const ui = uiStore.get();
    const geometries = regionGeometries(world, ui.smoothing, ui.time);
    const coordinates = geometries.get(regionId);
    if (!coordinates || coordinates.length === 0) return record ?? null;
    return {
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: coordinates as Position[][][] },
      properties: record?.properties ?? { id: regionId },
    };
  }

  /* --------------------------- кисти --------------------------- */

  private brushLabel(ui: UiState): string {
    if (ui.tool === 'height') return `Рельеф: ${ui.brush.heightOp}`;
    switch (ui.brush.target) {
      case 'biome':
        return 'Кисть: биом';
      case 'cultureId':
        return 'Кисть: культура';
      case 'religionId':
        return 'Кисть: религия';
      case 'languageId':
        return 'Кисть: язык';
      case 'regionId':
        return 'Кисть: регион';
      default:
        return 'Кисть: государство';
    }
  }

  private applyBrush(event: PointerEvent): void {
    const ui = uiStore.get();
    const world = worldStore.get();
    const lonLat = this.lonLatAt(event);
    if (!lonLat) return;
    if (world.cells.features.length === 0) {
      setStatus('Кисти работают по ячейкам — сначала импортируйте мир с сеткой ячеек');
      return;
    }

    const radius = this.radiusInDegrees(ui.brush.size, lonLat);
    const cellIds = cellsInRadius(world, lonLat[0], lonLat[1], radius);
    if (cellIds.length === 0) return;

    if (ui.tool === 'height') {
      applyHeightBrush(cellIds, {
        op: ui.brush.heightOp,
        strength: ui.brush.strength,
        center: lonLat,
        radius,
        time: ui.time,
        epoch: ui.geoEpochEdit,
      });
      this.drawBrushDelta(cellIds);
      return;
    }

    // пустое значение осмысленно для государства («ничьё») и региона («без региона»)
    if (ui.brush.target !== 'stateId' && ui.brush.target !== 'regionId' && ui.brush.value === '') {
      setStatus('Выберите значение для кисти в панели «Редактор»');
      return;
    }
    // политика и границы регионов по умолчанию правятся только с текущей эпохи,
    // география (рельеф, биомы, культуры) — в базовой карте
    const political = ui.brush.target === 'stateId' || ui.brush.target === 'regionId';
    applyPaint(cellIds, {
      target: ui.brush.target,
      value: ui.brush.value,
      time: ui.time,
      epoch: political ? ui.politicalEpochEdit : ui.geoEpochEdit,
    });
    this.drawBrushDelta(cellIds);
  }

  /** Мгновенная отрисовка закрашенных ячеек — без растворения границ и полного рендера. */
  private drawBrushDelta(cellIds: string[]): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    const topology = topologyOf(world);
    const [minHeight, maxHeight] = heightExtent(world);
    const sea = seaLevelOf(world);
    const overrides = overridesAt(world, ui.time);
    const ownership = ui.tool === 'paint' && ui.brush.target === 'stateId' ? regionOwnershipAt(world, ui.time) : null;

    // не даём группе распухнуть на длинном мазке
    if (this.liveGroup.childElementCount > 6000) this.liveGroup.replaceChildren();

    for (const id of cellIds) {
      const cell = topology.byId.get(id);
      if (!cell) continue;
      const d = this.path(cell as never);
      if (!d) continue;

      // в режиме правок эпохи база не меняется — цвет берём из эффективных свойств
      const properties = effectiveProperties(cell, overrides);
      let fill: string | null = null;
      if (ui.tool === 'height') {
        const height = Number(properties.height ?? 0);
        fill = ui.layers.heightmap
          ? heightColor(height, minHeight, maxHeight, sea)
          : biomeColorOf(properties.biome);
      } else {
        switch (ui.brush.target) {
          case 'stateId': {
            const regionId = properties.regionId;
            const owner = regionId ? ownership?.get(regionId) : undefined;
            fill = owner ? stateColor(world, owner) : 'rgba(120,130,145,0.35)';
            break;
          }
          case 'biome':
            fill = biomeColorOf(properties.biome);
            break;
          case 'cultureId':
            fill = cultureColor(world, properties.cultureId);
            break;
          case 'religionId':
            fill = religionColor(world, properties.religionId);
            break;
          case 'languageId':
            fill = languageColor(world, properties.languageId);
            break;
          case 'regionId':
            fill = 'rgba(110,168,254,0.55)';
            break;
        }
      }
      if (!fill) continue;

      const element = document.createElementNS(SVG_NS, 'path');
      element.setAttribute('class', 'map-path');
      element.setAttribute('d', d);
      element.setAttribute('fill', fill);
      this.liveGroup.appendChild(element);
    }
  }

  /* --------------------------- маршруты --------------------------- */

  /**
   * Опорная точка маршрута: между соседними опорами путь прокладывается
   * автоматически по ячейкам (A*), поэтому дорога обходит горы и держится
   * суши, а морской путь — воды.
   */
  private addRouteWaypoint(lonLat: [number, number]): void {
    const world = worldStore.get();
    const cellId = this.pickCell(lonLat);
    if (!cellId) {
      setStatus('Маршруты прокладываются по ячейкам — этому миру нужна сетка');
      return;
    }

    const ui = uiStore.get();
    const draft = this.routeDraft ?? { waypoints: [], cells: [] };
    if (draft.waypoints.length === 0) {
      draft.waypoints.push(cellId);
      draft.cells.push(cellId);
    } else {
      const from = draft.waypoints[draft.waypoints.length - 1];
      const mode = ui.routeGroup === 'searoutes' ? 'sea' : 'land';
      const path = findPath(world, from, cellId, { mode, seaLevel: seaLevelOf(world) });
      if (!path) {
        setStatus(
          ui.routeGroup === 'searoutes'
            ? 'Морской путь сюда не проходит — между точками нет воды'
            : 'Дорога сюда не проходит — между точками нет суши',
        );
        return;
      }
      draft.waypoints.push(cellId);
      draft.cells.push(...path.slice(1));
    }

    this.routeDraft = draft;
    setStatus(
      `Точек маршрута: ${draft.waypoints.length}, ячеек: ${draft.cells.length}. ` +
        'Enter — завершить, Backspace — убрать точку, Esc — отменить',
      12000,
    );
    this.renderRouteDraft();
  }

  /** Показать черновик: линия по центрам ячеек и кружки на опорах. */
  private renderRouteDraft(): void {
    const draft = this.routeDraft;
    if (!draft || draft.cells.length === 0) {
      this.routePath.removeAttribute('d');
      return;
    }
    const topology = topologyOf(worldStore.get());
    const parts: string[] = [];
    draft.cells.forEach((cellId, index) => {
      const point = topology.pointById.get(cellId);
      if (!point) return;
      const projected = this.projection([point.lon, point.lat]);
      if (!projected) return;
      parts.push(`${index === 0 ? 'M' : 'L'}${projected[0]},${projected[1]}`);
    });
    if (parts.length < 2) {
      this.routePath.removeAttribute('d');
      return;
    }
    this.routePath.setAttribute('d', parts.join(''));
  }

  /** Завершить маршрут и записать его в слой путей. */
  finishRoute(): void {
    const draft = this.routeDraft;
    if (!draft || draft.cells.length < 2) {
      this.cancelRoute();
      return;
    }
    const topology = topologyOf(worldStore.get());
    const points: Position[] = [];
    for (const cellId of draft.cells) {
      const point = topology.pointById.get(cellId);
      if (point) points.push([point.lon, point.lat]);
    }
    if (points.length >= 2) {
      const group = uiStore.get().routeGroup;
      addRoute(points, group);
      uiStore.update((state) => {
        state.layers.routes = true;
      });
      setStatus(`Маршрут построен: ${points.length} точек`);
    }
    this.routeDraft = null;
    this.renderRouteDraft();
    this.scheduleRender();
  }

  cancelRoute(): void {
    if (!this.routeDraft) return;
    this.routeDraft = null;
    this.renderRouteDraft();
    setStatus('Маршрут отменён');
  }

  /** Убрать последнюю опорную точку вместе с её отрезком. */
  removeLastRouteWaypoint(): void {
    const draft = this.routeDraft;
    if (!draft || draft.waypoints.length === 0) return;
    draft.waypoints.pop();
    if (draft.waypoints.length === 0) {
      this.routeDraft = null;
    } else {
      // пересобираем путь по оставшимся опорам
      const world = worldStore.get();
      const mode = uiStore.get().routeGroup === 'searoutes' ? 'sea' : 'land';
      const seaLevel = seaLevelOf(world);
      const cells: string[] = [draft.waypoints[0]];
      for (let i = 1; i < draft.waypoints.length; i++) {
        const path = findPath(world, draft.waypoints[i - 1], draft.waypoints[i], { mode, seaLevel });
        if (path) cells.push(...path.slice(1));
      }
      draft.cells = cells;
    }
    this.renderRouteDraft();
    setStatus('Последняя точка маршрута убрана');
  }

  hasRouteDraft(): boolean {
    return Boolean(this.routeDraft);
  }

  /* --------------------------- ручки вершин --------------------------- */

  private editableRegion(world: World, ui: UiState): Feature<Geometry, RegionProperties> | null {
    if (ui.tool !== 'vertices') return null;
    if (world.meta.regionSource !== 'geometry') return null;
    if (ui.selection?.kind !== 'region') return null;
    return world.regions.features.find((feature) => feature.properties.id === ui.selection!.id) ?? null;
  }

  private vertexRings(feature: Feature<Geometry, RegionProperties>): Position[][] {
    const geometry = feature.geometry;
    if (geometry.type === 'Polygon') return geometry.coordinates as Position[][];
    if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Position[][][]).flat();
    return [];
  }

  private renderVertexHandles(world: World, ui: UiState): void {
    this.handlesGroup.replaceChildren();
    const feature = this.editableRegion(world, ui);
    if (!feature) return;

    const rings = this.vertexRings(feature);
    rings.forEach((ring, ringIndex) => {
      const last = ring.length - 1;
      const closed = ring.length > 1 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
      const count = closed ? last : ring.length;
      for (let pointIndex = 0; pointIndex < count; pointIndex++) {
        const handle = document.createElementNS(SVG_NS, 'circle');
        handle.setAttribute('class', 'vertex-handle');
        handle.setAttribute('r', '4');
        handle.dataset.ring = String(ringIndex);
        handle.dataset.point = String(pointIndex);
        this.handlesGroup.appendChild(handle);
      }
    });
    this.positionVertexHandles();
  }

  private positionVertexHandles(): void {
    if (this.handlesGroup.childElementCount === 0) return;
    const world = worldStore.get();
    const ui = uiStore.get();
    const feature = this.editableRegion(world, ui);
    if (!feature) return;
    const rings = this.vertexRings(feature);
    for (const handle of Array.from(this.handlesGroup.children) as SVGCircleElement[]) {
      const ring = rings[Number(handle.dataset.ring)];
      const point = ring?.[Number(handle.dataset.point)];
      if (!point) continue;
      const projected = this.projection([point[0], point[1]]);
      if (!projected) continue;
      handle.setAttribute('cx', String(this.transform.applyX(projected[0])));
      handle.setAttribute('cy', String(this.transform.applyY(projected[1])));
    }
  }

  /** Вставить вершину в ближайшее ребро выбранного региона. */
  private insertVertexNear(lonLat: [number, number]): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    const feature = this.editableRegion(world, ui);
    if (!feature) return;

    let best: { ring: Position[]; index: number; distance: number } | null = null;
    for (const ring of this.vertexRings(feature)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const distance = distanceToSegment(lonLat, ring[i], ring[i + 1]);
        if (!best || distance < best.distance) best = { ring, index: i + 1, distance };
      }
    }
    if (!best) return;
    beginStroke('Вставка вершины');
    mutateWorld(() => {
      best!.ring.splice(best!.index, 0, [lonLat[0], lonLat[1]]);
    });
    endStroke();
    this.scheduleRender();
  }

  private removeVertex(reference: VertexRef): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    const feature = this.editableRegion(world, ui);
    if (!feature) return;
    const ring = this.vertexRings(feature)[reference.ringIndex];
    if (!ring || ring.length <= 5) {
      setStatus('В кольце должно остаться минимум 4 вершины');
      return;
    }
    beginStroke('Удаление вершины');
    mutateWorld(() => {
      ring.splice(reference.pointIndex, 1);
      // кольцо должно оставаться замкнутым
      ring[ring.length - 1] = [ring[0][0], ring[0][1]];
    });
    endStroke();
    this.scheduleRender();
  }

  private moveVertex(reference: VertexRef, lonLat: [number, number]): void {
    const world = worldStore.get();
    const ui = uiStore.get();
    const feature = this.editableRegion(world, ui);
    if (!feature) return;
    const rings = this.vertexRings(feature);
    const ring = rings[reference.ringIndex];
    if (!ring) return;
    mutateWorld(() => {
      ring[reference.pointIndex] = [lonLat[0], lonLat[1]];
      if (reference.pointIndex === 0) ring[ring.length - 1] = [lonLat[0], lonLat[1]];
    });
  }

  /* --------------------------- события мыши --------------------------- */

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.shiftKey) return;
    const ui = uiStore.get();
    const target = event.target as SVGElement;

    if (ui.tool === 'vertices' && target?.classList.contains('vertex-handle')) {
      const reference: VertexRef = {
        ringIndex: Number(target.dataset.ring),
        pointIndex: Number(target.dataset.point),
      };
      if (event.altKey) {
        this.removeVertex(reference);
        return;
      }
      this.draggingVertex = reference;
      beginStroke('Перенос вершины');
      this.capturePointer(event.pointerId);
      return;
    }

    if (ui.tool === 'points') {
      // клик по существующей точке — взять её, иначе поставить новую
      if (target?.dataset?.kind === 'burg' || target?.dataset?.kind === 'marker') {
        this.draggingPoint = { kind: target.dataset.kind as 'burg' | 'marker', id: target.dataset.id! };
        beginStroke('Перенос точки');
        this.capturePointer(event.pointerId);
        uiStore.update((state) => {
          state.selection = { kind: this.draggingPoint!.kind, id: this.draggingPoint!.id };
        });
        return;
      }
      const lonLat = this.lonLatAt(event);
      if (!lonLat) return;
      // в мире с несколькими эпохами новая точка основывается с текущей:
      // в прошлом её быть не должно
      const snapshots = worldStore.get().timeline.snapshots;
      const earliest =
        snapshots.length > 0 ? Math.min(...snapshots.map((item) => toNumericDate(item.date))) : null;
      const foundedFrom =
        snapshots.length > 1 && earliest !== null && ui.time > earliest ? String(Math.round(ui.time)) : undefined;

      const id =
        ui.point.kind === 'burg'
          ? addBurg(lonLat[0], lonLat[1], undefined, foundedFrom)
          : addMarker(lonLat[0], lonLat[1], ui.point.icon, undefined, foundedFrom);
      uiStore.update((state) => {
        state.selection = { kind: ui.point.kind, id };
        state.layers[ui.point.kind === 'burg' ? 'burgs' : 'markers'] = true;
      });
      setStatus(
        (ui.point.kind === 'burg' ? 'Город поставлен' : 'Метка поставлена') +
          (foundedFrom ? ` — существует с ${foundedFrom}` : '') +
          ' — название и даты в правой панели',
      );
      return;
    }

    if (ui.tool === 'paint' || ui.tool === 'height') {
      this.painting = true;
      this.capturePointer(event.pointerId);
      beginPaintSession();
      beginStroke(this.brushLabel(ui));
      this.applyBrush(event);
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const ui = uiStore.get();

    if (this.draggingPoint) {
      const lonLat = this.lonLatAt(event);
      if (lonLat) movePoint(this.draggingPoint.kind, this.draggingPoint.id, lonLat[0], lonLat[1]);
      return;
    }
    if (this.draggingVertex) {
      const lonLat = this.lonLatAt(event);
      if (lonLat) this.moveVertex(this.draggingVertex, lonLat);
      return;
    }
    if (this.painting) {
      this.applyBrush(event);
      this.updateBrushRing(event);
      return;
    }

    if (ui.tool === 'paint' || ui.tool === 'height') {
      this.updateBrushRing(event);
    } else {
      this.brushRing.style.display = 'none';
    }

    const target = event.target as SVGElement;
    if (target?.dataset?.kind) {
      const world = worldStore.get();
      const id = target.dataset.id!;
      if (target.dataset.kind === 'burg') {
        const burg = world.points.burgs.find((item) => item.id === id);
        if (burg) {
          const ui = uiStore.get();
          this.showTooltip(
            event,
            `<b>${escapeHtml(nameAt(burg, ui.time))}</b>${burg.population ? `<br>Население: ${burg.population}` : ''}`,
          );
          return;
        }
      } else {
        const marker = world.points.markers.find((item) => item.id === id);
        if (marker) {
          const ui = uiStore.get();
          this.showTooltip(
            event,
            `<b>${escapeHtml(nameAt(marker, ui.time))}</b>${
              marker.note ? `<br>${escapeHtml(marker.note.slice(0, 180))}` : ''
            }`,
          );
          return;
        }
      }
    }

    const lonLat = this.lonLatAt(event);
    if (!lonLat) {
      this.hoverPath.removeAttribute('d');
      this.hideTooltip();
      return;
    }
    this.updateHover(lonLat, event);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.draggingPoint) {
      this.draggingPoint = null;
      endStroke();
      this.scheduleRender();
    }
    if (this.draggingVertex) {
      this.draggingVertex = null;
      endStroke();
      this.scheduleRender();
    }
    if (this.painting) {
      this.painting = false;
      endPaintSession();
      endStroke();
      this.scheduleRender();
    }
    try {
      if (this.svg.hasPointerCapture?.(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    } catch {
      /* указатель мог быть уже отпущен */
    }
  };

  /** Захват указателя не критичен: без него мазок просто прервётся у края карты. */
  private capturePointer(pointerId: number): void {
    try {
      this.svg.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }
  }

  private onPointerLeave = (): void => {
    this.hoverPath.removeAttribute('d');
    this.brushRing.style.display = 'none';
    this.hideTooltip();
  };

  private onClick = (event: MouseEvent): void => {
    const ui = uiStore.get();
    if (ui.tool === 'paint' || ui.tool === 'height' || ui.tool === 'points') return;

    if (ui.tool === 'route') {
      const lonLat = this.lonLatAt(event);
      if (lonLat) this.addRouteWaypoint(lonLat);
      return;
    }

    const target = event.target as SVGElement;
    if (target?.dataset?.kind === 'burg' || target?.dataset?.kind === 'marker') {
      uiStore.update((state) => {
        state.selection = { kind: target.dataset.kind as 'burg' | 'marker', id: target.dataset.id! };
      });
      return;
    }

    const lonLat = this.lonLatAt(event);
    if (!lonLat) return;

    if (ui.tool === 'vertices') {
      if (target?.classList.contains('vertex-handle')) return;
      const world = worldStore.get();
      if (this.editableRegion(world, ui)) {
        this.insertVertexNear(lonLat);
        return;
      }
    }

    const world = worldStore.get();
    const regionId = ui.layers.states || ui.layers.regionBorders ? this.pickRegion(lonLat) : null;
    if (regionId) {
      // Alt+клик поднимается на уровень выше: выбирает владельца, а не сам регион
      const owner = event.altKey ? regionOwnershipAt(world, ui.time).get(regionId) : undefined;
      uiStore.update((state) => {
        state.selection = owner ? { kind: 'state', id: owner } : { kind: 'region', id: regionId };
      });
      return;
    }
    const cellId = this.pickCell(lonLat);
    uiStore.update((state) => {
      state.selection = cellId ? { kind: 'cell', id: cellId } : null;
    });
    if (!cellId && world.cells.features.length === 0) this.hideTooltip();
  };

  private updateBrushRing(event: PointerEvent): void {
    const ui = uiStore.get();
    const rect = this.svg.getBoundingClientRect();
    this.brushRing.setAttribute('cx', String(event.clientX - rect.left));
    this.brushRing.setAttribute('cy', String(event.clientY - rect.top));
    this.brushRing.setAttribute('r', String(ui.brush.size));
    this.brushRing.style.display = '';
  }

  private updateHover(lonLat: [number, number], event: PointerEvent): void {
    const world = worldStore.get();
    const ui = uiStore.get();

    if (ui.layers.states && world.timeline.states.length > 0) {
      const regionId = this.pickRegion(lonLat);
      if (regionId) {
        const feature = this.regionFeature(world, regionId);
        const d = feature ? this.path(feature as never) : null;
        if (d) this.hoverPath.setAttribute('d', d);
        else this.hoverPath.removeAttribute('d');
        const ownership = regionOwnershipAt(world, ui.time);
        const state = stateAt(world, ownership.get(regionId), ui.time);
        const name = regionNameAt(world, regionId, ui.time);
        this.showTooltip(
          event,
          `<b>${escapeHtml(String(name))}</b><br>${state ? escapeHtml(state.name) : '<span class="muted">ничьё</span>'}`,
        );
        return;
      }
    }

    const cellId = this.pickCell(lonLat);
    if (!cellId) {
      this.hoverPath.removeAttribute('d');
      this.hideTooltip();
      return;
    }
    const cell = topologyOf(world).byId.get(cellId);
    if (!cell) return;
    const d = this.path(cell as never);
    if (d) this.hoverPath.setAttribute('d', d);
    const properties = effectiveProperties(cell, overridesAt(world, ui.time));
    const culture = world.dictionaries.cultures.find((item) => item.id === properties.cultureId);
    const parts = [`<b>${escapeHtml(String(properties.biome ?? properties.id))}</b>`];
    if (typeof properties.height === 'number') parts.push(`высота ${properties.height}`);
    if (culture) parts.push(escapeHtml(culture.name));
    this.showTooltip(event, parts.join('<br>'));
  }

  private updateOutlines(world: World, ui: UiState): void {
    this.selectPath.removeAttribute('d');
    const selection = ui.selection;
    if (!selection) return;
    let source: Feature<Geometry, unknown> | null | undefined;
    if (selection.kind === 'state') {
      // территория государства на текущий момент — это уже растворённая область слоя политики
      const resolved = resolveStateId(world, selection.id, ui.time) ?? selection.id;
      const layer = this.layers.find((item) => item.id === 'states');
      source = layer?.features.find((feature) => String(feature.properties.id) === resolved) as
        | Feature<Geometry, unknown>
        | undefined;
    } else if (selection.kind === 'region') source = this.regionFeature(world, selection.id);
    else if (selection.kind === 'cell') source = topologyOf(world).byId.get(selection.id);
    if (!source) return;
    const d = this.path(source as never);
    if (d) this.selectPath.setAttribute('d', d);
  }

  private showTooltip(event: MouseEvent, html: string): void {
    const rect = this.container.getBoundingClientRect();
    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    this.tooltip.style.top = `${event.clientY - rect.top + 14}px`;
  }

  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }
}

function distanceToSegment(point: [number, number], a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  );
}
