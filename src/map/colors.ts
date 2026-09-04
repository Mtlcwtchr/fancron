import { scaleLinear } from 'd3-scale';

/** Порядок биомов Azgaar по умолчанию — индекс из cells.geojson резолвится в имя. */
export const AZGAAR_BIOMES = [
  'Marine',
  'Hot desert',
  'Cold desert',
  'Savanna',
  'Grassland',
  'Tropical seasonal forest',
  'Temperate deciduous forest',
  'Tropical rainforest',
  'Temperate rainforest',
  'Taiga',
  'Tundra',
  'Glacier',
  'Wetland',
];

/** Палитра биомов, близкая к FMG. */
export const BIOME_COLORS: Record<string, string> = {
  Marine: '#466eab',
  'Hot desert': '#fbe79f',
  'Cold desert': '#b5b887',
  Savanna: '#d2d082',
  Grassland: '#c8d68f',
  'Tropical seasonal forest': '#b6d95d',
  'Temperate deciduous forest': '#29bc56',
  'Tropical rainforest': '#7dcb35',
  'Temperate rainforest': '#409c43',
  Taiga: '#4b6b32',
  Tundra: '#96784b',
  Glacier: '#d5e7eb',
  Wetland: '#0b9131',
  Lake: '#5b93c7',
};

/** Категориальная палитра для культур/религий/языков/государств. */
export const CATEGORICAL = [
  '#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2',
  '#d19a66', '#7f9f7f', '#b294bb', '#81a2be', '#de935f', '#8abeb7',
  '#cc6666', '#b5bd68', '#f0c674', '#a3685a', '#85678f', '#5f819d',
  '#a54242', '#8c9440', '#de7c3c', '#6e8fa6',
];

export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function categoricalColor(key: string | number | undefined, offset = 0): string {
  if (key === undefined || key === null || key === '') return '#4a5568';
  const index = typeof key === 'number' ? key : hashString(String(key));
  return CATEGORICAL[(index + offset) % CATEGORICAL.length];
}

export function biomeColor(biome: string | number | undefined): string {
  if (biome === undefined || biome === null || biome === '') return '#2b3444';
  const name = typeof biome === 'number' ? AZGAAR_BIOMES[biome] ?? String(biome) : biome;
  return BIOME_COLORS[name] ?? categoricalColor(name, 3);
}

/** Море -> берег -> равнина -> горы -> снег. Высоты нормализуются в [0..1]. */
const heightRamp = scaleLinear<string>()
  .domain([0, 0.18, 0.2, 0.35, 0.55, 0.75, 0.92, 1])
  .range(['#0b1b33', '#2e5e8f', '#7fb3a0', '#c6d68f', '#a9a05e', '#8a6f4b', '#a89a92', '#ffffff'])
  .clamp(true);

export function heightColor(height: number, min: number, max: number, seaLevel = 20): string {
  const span = max - min || 1;
  // Azgaar: высоты 0..100, уровень моря = 20. Для произвольных данных просто нормируем.
  const normalized =
    min >= 0 && max <= 100 ? height / 100 : (height - min) / span;
  const adjusted = min >= 0 && max <= 100 ? normalized : normalized * (1 - seaLevel / 100) + seaLevel / 100;
  return heightRamp(adjusted);
}

/** Температура: от полярной синевы к пустынному красному. */
const temperatureRamp = scaleLinear<string>()
  .domain([-30, -10, 0, 10, 20, 30, 40])
  .range(['#2b3f6b', '#4a7fb5', '#7fb7cf', '#a8c98b', '#e0c273', '#d98a4a', '#b8474f'])
  .clamp(true);

export function temperatureColor(value: number): string {
  return temperatureRamp(value);
}

/** Осадки: от сухого песка к насыщенной зелени и синеве. */
const precipitationRamp = scaleLinear<string>()
  .domain([0, 0.02, 0.05, 0.1, 0.2, 0.4])
  .range(['#d8c69a', '#c8cf8a', '#9ec97e', '#5fae7a', '#3f8fa6', '#2f5f9e'])
  .clamp(true);

export function precipitationColor(value: number): string {
  return precipitationRamp(value);
}

export function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function readableTextColor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '#fff';
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#10141b' : '#ffffff';
}
