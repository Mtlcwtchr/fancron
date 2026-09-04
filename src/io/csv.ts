/** Мини-парсер CSV/TSV: кавычки, экранированные кавычки, автоопределение разделителя. */

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
}

function detectDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  const firstLine = sample.split(/\r?\n/)[0] ?? '';
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter?: string): CsvTable {
  const content = text.replace(/^﻿/, '');
  const delim = delimiter ?? detectDelimiter(content);
  const rowsRaw: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delim) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rowsRaw.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // пропускаем, обработается на \n
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rowsRaw.push(row);
  }

  const headerRow = rowsRaw.shift() ?? [];
  const headers = headerRow.map((h) => h.trim());
  const rows = rowsRaw
    .filter((cells) => cells.some((c) => c.trim() !== ''))
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = (cells[index] ?? '').trim();
      });
      return record;
    });

  return { headers, rows, delimiter: delim };
}

/** Достать значение по одному из возможных имён колонки (без учёта регистра/пробелов). */
export function pick(row: Record<string, string>, ...names: string[]): string | undefined {
  const normalized = new Map<string, string>();
  for (const key of Object.keys(row)) {
    normalized.set(key.toLowerCase().replace(/[\s_]+/g, ''), row[key]);
  }
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[\s_]+/g, ''));
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function pickNumber(row: Record<string, string>, ...names: string[]): number | undefined {
  const raw = pick(row, ...names);
  if (raw === undefined) return undefined;
  const value = parseFloat(raw.replace(/[^0-9.+-eE]/g, ''));
  return Number.isFinite(value) ? value : undefined;
}

export function pickBool(row: Record<string, string>, ...names: string[]): boolean | undefined {
  const raw = pick(row, ...names);
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'да', '+'].includes(value)) return true;
  if (['0', 'false', 'no', 'нет', '-', ''].includes(value)) return false;
  return undefined;
}
