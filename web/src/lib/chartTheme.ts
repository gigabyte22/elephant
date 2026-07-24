// Shared recharts styling — extracted from Timeline so every chart on the
// dashboard reads as the same instrument: hairline grid, mono axis ticks,
// squared-off ink-900 tooltip, accent/cyan/rust series palette.

export const chartColors = {
  accent: '#FF5C8A', // primary series (accent-500)
  accentSoft: '#FFB0CD', // secondary accent series (accent-300)
  cyan: '#5EE3D8', // connector / secondary data tone (cyan-400)
  rust: '#D26B8C', // failures, pruning, decay warnings
  ink: '#A4A0B5', // neutral series (ink-300)
  inkDim: '#6A6580', // axis ticks (ink-400)
} as const;

export const chartGridProps = {
  stroke: 'rgba(255,196,225,0.06)',
  vertical: false,
} as const;

export const chartAxisTick = {
  fill: chartColors.inkDim,
  fontSize: 11,
  fontFamily: 'JetBrains Mono',
} as const;

export const chartXAxisProps = {
  stroke: 'rgba(255,196,225,0.10)',
  tick: chartAxisTick,
  tickLine: false,
  axisLine: { stroke: 'rgba(255,196,225,0.06)' },
} as const;

export const chartYAxisProps = {
  stroke: 'rgba(255,196,225,0.10)',
  tick: chartAxisTick,
  tickLine: false,
  axisLine: false,
  allowDecimals: false,
  width: 40,
} as const;

export const chartTooltipProps = {
  cursor: { fill: 'rgba(255,92,138,0.06)' },
  contentStyle: {
    background: '#0C0A14',
    border: '1px solid rgba(255,196,225,0.18)',
    borderRadius: 0,
    fontFamily: 'JetBrains Mono',
    fontSize: 11,
    color: '#E6E1ED',
  },
  // Scatter tooltip payload entries carry no series color, and recharts'
  // DefaultTooltipContent falls back to #000 — invisible on the dark panel.
  itemStyle: { color: '#E6E1ED' },
  labelStyle: { color: '#A4A0B5' },
} as const;
