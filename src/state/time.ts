import type { EraLabels, Snapshot, TimelineEvent } from './types';

/**
 * Даты в мире — произвольные строки («-1200», «1200 A.E.», «Год Пепла 34»).
 * Для шкалы нужно число: берём первое числовое вхождение.
 */
export function toNumericDate(date: string | number | undefined | null): number {
  if (typeof date === 'number' && Number.isFinite(date)) return date;
  if (date == null) return 0;
  const match = String(date).match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return 0;
  return parseFloat(match[0].replace(',', '.'));
}

export function formatDate(value: number, era?: EraLabels): string {
  const rounded = Math.round(value * 100) / 100;
  if (!era) return String(rounded);
  const suffix = rounded < 0 ? era.negative : era.positive;
  const abs = rounded < 0 && era.negative ? Math.abs(rounded) : rounded;
  return suffix ? `${abs} ${suffix}` : String(rounded);
}

export interface TimeExtent {
  min: number;
  max: number;
}

export function timeExtent(snapshots: Snapshot[], events: TimelineEvent[]): TimeExtent {
  const values = [
    ...snapshots.map((s) => toNumericDate(s.date)),
    ...events.map((e) => toNumericDate(e.date)),
  ];
  if (values.length === 0) return { min: 0, max: 100 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 50;
    max += 50;
  }
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}

export function sortedSnapshots(snapshots: Snapshot[]): Snapshot[] {
  return [...snapshots].sort((a, b) => toNumericDate(a.date) - toNumericDate(b.date));
}

/** Последний snapshot на момент времени `time` (или самый ранний, если time раньше всех). */
export function snapshotAt(snapshots: Snapshot[], time: number): Snapshot | null {
  const sorted = sortedSnapshots(snapshots);
  if (sorted.length === 0) return null;
  let found: Snapshot | null = null;
  for (const snap of sorted) {
    if (toNumericDate(snap.date) <= time) found = snap;
    else break;
  }
  return found ?? sorted[0];
}
