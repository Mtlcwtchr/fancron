let counter = 0;

/** Короткий уникальный id с префиксом: "snap-3f2a1b". */
export function uid(prefix: string): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${counter.toString(36)}${random}`;
}

export function slugify(value: string, fallback = 'item'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** Уникализация id внутри набора: name, name-2, name-3... */
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  const result = `${base}-${index}`;
  taken.add(result);
  return result;
}
