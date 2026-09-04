/**
 * Простая климатическая эвристика: биом по высоте и широте.
 * Нужна там, где ячейка меняет сторону берега — поднятая из моря земля не должна
 * оставаться «Marine», а затопленная суша обязана стать морем.
 */
export function biomeForConditions(height: number, lat: number, sea: number, maxHeight = 100): string {
  if (height < sea) return 'Marine';
  const relief = Math.min(1, Math.max(0, (height - sea) / Math.max(1, maxHeight - sea)));
  const absLat = Math.abs(lat);

  if (relief > 0.72) return absLat > 34 ? 'Glacier' : 'Taiga';
  if (absLat > 44) return 'Tundra';
  if (absLat > 34) return relief > 0.45 ? 'Taiga' : 'Temperate deciduous forest';
  if (absLat > 20) return relief > 0.5 ? 'Temperate rainforest' : 'Grassland';
  if (absLat > 10) return relief > 0.52 ? 'Savanna' : 'Tropical seasonal forest';
  return relief > 0.58 ? 'Hot desert' : 'Tropical rainforest';
}
