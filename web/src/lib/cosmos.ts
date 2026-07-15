import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { GraphOverviewPayload } from '../api/types.ts';
import { truncateText } from './format.ts';
import { styleForKind } from './kindStyle.ts';

// Cosmos layout — turns the whole-graph overview payload into an orbital
// "galaxy" arrangement:
//   1. Louvain community detection (client-side, seeded → stable per payload)
//   2. each community ≥ MIN_GALAXY becomes a galaxy: a glowing synthetic core
//      node + members placed on concentric orbit rings (densest first)
//   3. galaxies are packed on a golden-angle spiral, sized by member count
//   4. leftover micro-communities become the outer "dust" belt
// Every member carries orbit parameters (cx, cy, orbitR, theta0, speed) so the
// canvas can animate real orbital motion without recomputing the layout.

export const CORE_PREFIX = '__core:';
export const DIM_NODE = '#16141F';
export const DUST_COLOR = '#55506A';

const MIN_GALAXY = 4; // communities smaller than this fall into the dust belt
const RING_GAP = 30; // distance between orbit rings (graph units)
const NODE_ARC = 17; // min arc length per node along a ring

// Vivid against the noir void — gold / violet / blue / pink / cyan / green,
// echoing the Accent palette without collapsing into it.
export const GALAXY_PALETTE = [
  '#FFC857',
  '#B47CFF',
  '#5EA8FF',
  '#FF5C8A',
  '#5EE3D8',
  '#6EE7A8',
  '#FF9D5C',
  '#E06BFF',
  '#C9E15E',
  '#FF8AB8',
  '#8FA0FF',
  '#F2B8FF',
];

export interface GalaxyMeta {
  community: string;
  name: string;
  color: string;
  count: number;
  coreId: string | null; // null for the dust belt
  cx: number;
  cy: number;
  radius: number;
  isDust: boolean;
}

export interface CosmosBuild {
  graph: Graph;
  galaxies: GalaxyMeta[];
  bbox: { x: [number, number]; y: [number, number] };
}

// --- small deterministic helpers -------------------------------------------

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Mix `hex` toward `toward` by t ∈ [0,1]. t=0 → hex unchanged. */
export function mixHex(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const ch = (shift: number) => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

// --- galaxy naming ----------------------------------------------------------

function nameGalaxy(
  members: string[],
  simple: Graph,
  labels: Map<string, { kind: string; label: string }>,
  used: Set<string>,
): string {
  // Prefer the busiest entity in the community; fall back to dominant kind.
  let bestEntity: string | null = null;
  let bestDegree = -1;
  const kindCounts = new Map<string, number>();
  for (const id of members) {
    const meta = labels.get(id);
    if (!meta) continue;
    kindCounts.set(meta.kind, (kindCounts.get(meta.kind) ?? 0) + 1);
    if (meta.kind === 'entity' && simple.degree(id) > bestDegree) {
      bestDegree = simple.degree(id);
      bestEntity = meta.label;
    }
  }
  let name: string;
  if (bestEntity) {
    name = truncateText(bestEntity, 16).toUpperCase();
  } else {
    const dominant = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    name = `${(dominant?.[0] ?? 'memory').replace(/_/g, ' ')}s`.toUpperCase();
  }
  if (used.has(name)) {
    let i = 2;
    while (used.has(`${name} ${i}`)) i++;
    name = `${name} ${i}`;
  }
  used.add(name);
  return name;
}

// --- galaxy packing ---------------------------------------------------------

const GOLDEN_ANGLE = 2.399963229728653;

function packGalaxies(radii: number[]): Array<{ x: number; y: number }> {
  const placed: Array<{ x: number; y: number; r: number }> = [];
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i];
    if (i === 0) {
      placed.push({ x: 0, y: 0, r });
      out.push({ x: 0, y: 0 });
      continue;
    }
    let x = 0;
    let y = 0;
    for (let k = 1; k < 4000; k++) {
      const ang = k * GOLDEN_ANGLE;
      const dist = 50 + 24 * Math.sqrt(k);
      x = Math.cos(ang) * dist;
      y = Math.sin(ang) * dist;
      const cx = x;
      const cy = y;
      if (placed.every((p) => Math.hypot(p.x - cx, p.y - cy) > p.r + r + 65)) break;
    }
    placed.push({ x, y, r });
    out.push({ x, y });
  }
  return out;
}

// --- main build -------------------------------------------------------------

export function buildCosmos(payload: GraphOverviewPayload): CosmosBuild {
  // Simple undirected mirror for Louvain + degree math (Louvain rejects
  // multigraphs).
  const simple = new Graph({ type: 'undirected' });
  const labels = new Map<string, { kind: string; label: string }>();
  for (const node of payload.nodes) {
    if (simple.hasNode(node.id)) continue;
    simple.addNode(node.id);
    labels.set(node.id, { kind: node.kind, label: node.label || node.id });
  }
  for (const e of payload.edges) {
    if (!simple.hasNode(e.source) || !simple.hasNode(e.target)) continue;
    if (e.source === e.target) continue;
    simple.mergeEdge(e.source, e.target);
  }

  const communities: Record<string, number> =
    simple.order > 0 && simple.size > 0
      ? louvain(simple, { rng: mulberry32(42) })
      : Object.fromEntries(simple.nodes().map((n, i) => [n, i]));

  const groups = new Map<string, string[]>();
  for (const [node, comm] of Object.entries(communities)) {
    const key = String(comm);
    const arr = groups.get(key);
    if (arr) arr.push(node);
    else groups.set(key, [node]);
  }

  const galaxyGroups = [...groups.entries()]
    .filter(([, members]) => members.length >= MIN_GALAXY)
    .sort((a, b) => b[1].length - a[1].length);
  const dustMembers = [...groups.entries()]
    .filter(([, members]) => members.length < MIN_GALAXY)
    .flatMap(([, members]) => members);

  // Pre-compute each galaxy's ring layout so we know its radius before packing.
  const usedNames = new Set<string>();
  const prelim = galaxyGroups.map(([community, members], i) => {
    const sorted = [...members].sort((a, b) => simple.degree(b) - simple.degree(a));
    const rings: string[][] = [];
    let cursor = 0;
    for (let ring = 1; cursor < sorted.length; ring++) {
      const capacity = Math.max(5, Math.floor((2 * Math.PI * ring * RING_GAP) / NODE_ARC));
      rings.push(sorted.slice(cursor, cursor + capacity));
      cursor += capacity;
    }
    return {
      community,
      members: sorted,
      rings,
      radius: (rings.length + 0.8) * RING_GAP,
      color: GALAXY_PALETTE[i % GALAXY_PALETTE.length],
      name: nameGalaxy(members, simple, labels, usedNames),
    };
  });

  const centers = packGalaxies(prelim.map((p) => p.radius));

  const g = new Graph({ multi: true });
  const galaxies: GalaxyMeta[] = [];
  const nodeCommunity = new Map<string, string>();
  const communityColor = new Map<string, string>();

  let maxExtent = 0;
  prelim.forEach((galaxy, gi) => {
    const { x: cx, y: cy } = centers[gi];
    maxExtent = Math.max(maxExtent, Math.hypot(cx, cy) + galaxy.radius);
    const dir = hash01(galaxy.community) > 0.5 ? 1 : -1;

    const coreId = `${CORE_PREFIX}${galaxy.community}`;
    g.addNode(coreId, {
      label: `${galaxy.name} · ${galaxy.members.length}`,
      kind: '__core',
      isCore: true,
      community: galaxy.community,
      size: Math.min(38, 13 + Math.sqrt(galaxy.members.length) * 2.1),
      color: mixHex(galaxy.color, '#0C0A14', 0.55),
      coreColor: mixHex(galaxy.color, '#0C0A14', 0.55),
      communityColor: galaxy.color,
      kindColor: galaxy.color,
      forceLabel: true,
      zIndex: 0,
      x: cx,
      y: cy,
      cx,
      cy,
      orbitR: 0,
      theta0: 0,
      speed: 0,
    });

    galaxy.rings.forEach((ring, ri) => {
      const orbitR = (ri + 1) * RING_GAP;
      ring.forEach((id, j) => {
        const meta = labels.get(id);
        if (!meta) return;
        const jitter = hash01(id);
        const theta0 =
          (j / ring.length) * 2 * Math.PI + jitter * ((2 * Math.PI) / ring.length) * 0.6;
        const degree = simple.degree(id);
        g.addNode(id, {
          label: truncateText(meta.label, 36),
          kind: meta.kind,
          community: galaxy.community,
          size: Math.min(9, 2.6 + Math.sqrt(degree) * 1.15) + (meta.kind === 'entity' ? 0.8 : 0),
          color: galaxy.color,
          communityColor: galaxy.color,
          kindColor: styleForKind(meta.kind).color,
          zIndex: 1,
          x: cx + orbitR * Math.cos(theta0),
          y: cy + orbitR * Math.sin(theta0),
          cx,
          cy,
          orbitR,
          theta0,
          // Keplerian-ish: inner rings sweep faster; whole galaxies alternate direction.
          speed: (dir * (0.1 + jitter * 0.04)) / (ri + 1) ** 0.8,
        });
        nodeCommunity.set(id, galaxy.community);
      });
    });

    communityColor.set(galaxy.community, galaxy.color);
    galaxies.push({
      community: galaxy.community,
      name: galaxy.name,
      color: galaxy.color,
      count: galaxy.members.length,
      coreId,
      cx,
      cy,
      radius: galaxy.radius,
      isDust: false,
    });
  });

  // Dust belt — everything that didn't cohere into a galaxy drifts on a slow
  // outer ring around the whole cosmos.
  if (dustMembers.length > 0) {
    const beltR = Math.max(maxExtent + 110, 220);
    dustMembers.forEach((id, i) => {
      const meta = labels.get(id);
      if (!meta) return;
      const jitter = hash01(id);
      const theta0 = (i / dustMembers.length) * 2 * Math.PI + jitter * 0.4;
      const orbitR = beltR + (jitter - 0.5) * 90;
      g.addNode(id, {
        label: truncateText(meta.label, 36),
        kind: meta.kind,
        community: '__dust',
        size: 2.4,
        color: DUST_COLOR,
        communityColor: DUST_COLOR,
        kindColor: styleForKind(meta.kind).color,
        zIndex: 1,
        x: orbitR * Math.cos(theta0),
        y: orbitR * Math.sin(theta0),
        cx: 0,
        cy: 0,
        orbitR,
        theta0,
        speed: 0.008 + jitter * 0.006,
      });
      nodeCommunity.set(id, '__dust');
    });
    communityColor.set('__dust', DUST_COLOR);
    galaxies.push({
      community: '__dust',
      name: 'DUST',
      color: DUST_COLOR,
      count: dustMembers.length,
      coreId: null,
      cx: 0,
      cy: 0,
      radius: beltR,
      isDust: true,
    });
    maxExtent = beltR + 90;
  }

  for (const e of payload.edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    if (g.hasEdge(e.id)) continue;
    const cs = nodeCommunity.get(e.source);
    const ct = nodeCommunity.get(e.target);
    const same = cs !== undefined && cs === ct;
    g.addEdgeWithKey(e.id, e.source, e.target, {
      size: same ? 0.7 : 0.5,
      type: 'line',
      relType: e.type,
      sameCommunity: same,
      communityColor: same ? (communityColor.get(cs) ?? DUST_COLOR) : DUST_COLOR,
      zIndex: 0,
    });
  }

  const extent = Math.max(maxExtent, 200) + 80;
  return {
    graph: g,
    galaxies,
    bbox: { x: [-extent, extent], y: [-extent, extent] },
  };
}
