import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/react-sigma.min.css';
import { MultiGraph } from 'graphology';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CORE_PREFIX, type CosmosBuild, DIM_NODE, hexToRgba, mixHex } from '../../lib/cosmos.ts';

// Sigma renderer for the cosmos view. The graph (with orbit parameters baked
// into node attributes) is built once per payload in lib/cosmos.ts; this
// component only animates positions and restyles via reducers:
//   - orbit driver: RAF loop sweeping members around their galaxy core
//   - hover / selection: spotlight the node + neighborhood, dim the rest
//   - filters / view-by / link styling: all handled in node + edge reducers
// A fixed custom bbox keeps Sigma from re-normalizing coordinates every frame
// (which would make the whole cosmos wobble while orbiting).

export interface CosmosSettings {
  viewBy: 'community' | 'kind';
  hiddenKinds: string[];
  // When false (default), raw conversation layers (chunks/episodes/observations)
  // are excluded server-side so the cosmos shows the knowledge graph, not the
  // transcript. Toggling refetches a balanced snapshot that includes them.
  showRawLayers: boolean;
  orbit: boolean;
  orbitSpeed: number; // multiplier, 0.2..3
  edgeOpacity: number; // multiplier, 0..2
  interGalaxy: boolean;
  galaxyLabels: boolean;
}

export interface FlyTarget {
  id: string;
  ratio: number;
  nonce: number;
}

interface Props {
  build: CosmosBuild | null;
  settings: CosmosSettings;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDive: (id: string) => void;
  flyTarget: FlyTarget | null;
}

export function CosmosCanvas(props: Props) {
  const sigmaSettings = useMemo(
    () => ({
      defaultNodeType: 'circle' as const,
      defaultEdgeColor: 'rgba(255,196,225,0.10)',
      labelColor: { color: '#A4A0B5' },
      labelSize: 10,
      labelFont: '"JetBrains Mono", ui-monospace, monospace',
      labelWeight: '500',
      labelDensity: 0.45,
      labelGridCellSize: 130,
      labelRenderedSizeThreshold: 5.5,
      renderEdgeLabels: false,
      zIndex: true,
      minCameraRatio: 0.02,
      maxCameraRatio: 2,
    }),
    [],
  );

  return (
    <SigmaContainer
      graph={MultiGraph}
      style={{ background: 'transparent', height: '100%', width: '100%' }}
      settings={sigmaSettings}
    >
      <CosmosController {...props} />
    </SigmaContainer>
  );
}

function CosmosController({ build, settings, selectedId, onSelect, onDive, flyTarget }: Props) {
  const sigma = useSigma();
  const loadGraph = useLoadGraph();
  const registerEvents = useRegisterEvents();
  const [hovered, setHovered] = useState<string | null>(null);
  // Accumulated, speed-scaled orbital time — survives speed changes without
  // making every node jump to a new phase.
  const orbitTime = useRef(0);

  // --- load -----------------------------------------------------------------
  useEffect(() => {
    if (!build) return;
    loadGraph(build.graph);
    sigma.setCustomBBox(build.bbox);
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1.05 });
    sigma.refresh();
  }, [build, loadGraph, sigma]);

  // --- events ----------------------------------------------------------------
  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        if (node.startsWith(CORE_PREFIX)) {
          // Clicking a galaxy core zooms into the galaxy instead of selecting.
          const d = sigma.getNodeDisplayData(node);
          if (d) {
            sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.32 }, { duration: 550 });
          }
          return;
        }
        onSelect(node);
      },
      doubleClickNode: (e) => {
        e.event.preventSigmaDefault();
        if (!e.node.startsWith(CORE_PREFIX)) onDive(e.node);
      },
      clickStage: () => onSelect(null),
      enterNode: ({ node }) => {
        setHovered(node);
        sigma.getContainer().style.cursor = 'pointer';
      },
      leaveNode: () => {
        setHovered(null);
        sigma.getContainer().style.cursor = 'default';
      },
    });
  }, [registerEvents, sigma, onSelect, onDive]);

  // --- camera fly-to ----------------------------------------------------------
  useEffect(() => {
    if (!flyTarget) return;
    if (!sigma.getGraph().hasNode(flyTarget.id)) return;
    const d = sigma.getNodeDisplayData(flyTarget.id);
    if (!d) return;
    sigma.getCamera().animate({ x: d.x, y: d.y, ratio: flyTarget.ratio }, { duration: 600 });
  }, [flyTarget, sigma]);

  // --- orbit driver ------------------------------------------------------------
  useEffect(() => {
    if (!build || !settings.orbit) return;
    let raf = 0;
    let last = performance.now();
    const graph = sigma.getGraph();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      orbitTime.current += dt * settings.orbitSpeed;
      const t = orbitTime.current;
      graph.updateEachNodeAttributes(
        (_node, attrs) => {
          if (attrs.orbitR) {
            const a = attrs.theta0 + attrs.speed * t;
            attrs.x = attrs.cx + attrs.orbitR * Math.cos(a);
            attrs.y = attrs.cy + attrs.orbitR * Math.sin(a);
          }
          return attrs;
        },
        { attributes: ['x', 'y'] },
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [build, settings.orbit, settings.orbitSpeed, sigma]);

  // --- reducers (style pipeline) -----------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: `build` intentionally re-triggers styling after a graph rebuild
  useEffect(() => {
    const graph = sigma.getGraph();
    const hidden = new Set(settings.hiddenKinds);

    // Spotlight set: hovered wins over selected. Hovering a core lights its
    // whole galaxy; hovering a member lights its direct neighborhood.
    const focus = hovered ?? selectedId;
    let spotlight: Set<string> | null = null;
    if (focus && graph.hasNode(focus)) {
      spotlight = new Set([focus]);
      if (focus.startsWith(CORE_PREFIX)) {
        const community = graph.getNodeAttribute(focus, 'community');
        graph.forEachNode((n, attrs) => {
          if (attrs.community === community) spotlight?.add(n);
        });
      } else {
        graph.forEachNeighbor(focus, (n) => spotlight?.add(n));
      }
    }
    const labelNeighbors = spotlight !== null && spotlight.size <= 40;
    // Hovering dims the rest of the cosmos hard (transient); a sticky
    // selection only mutes it, so the surrounding structure stays readable
    // while the inspector is open.
    const strongDim = hovered !== null;

    sigma.setSetting('nodeReducer', (node, data) => {
      const res: Record<string, unknown> = { ...data };
      if (data.isCore) {
        res.color = data.coreColor;
        if (!settings.galaxyLabels) {
          res.forceLabel = false;
          res.label = '';
        }
        if (spotlight && !spotlight.has(node)) {
          res.color = mixHex(String(data.communityColor), '#06050C', 0.85);
          res.label = '';
          res.forceLabel = false;
        }
        return res;
      }
      if (hidden.has(String(data.kind))) {
        res.hidden = true;
        return res;
      }
      res.color = settings.viewBy === 'community' ? data.communityColor : data.kindColor;
      if (spotlight) {
        if (spotlight.has(node)) {
          res.zIndex = 3;
          if (node === focus || labelNeighbors) res.forceLabel = true;
        } else {
          res.color = strongDim ? DIM_NODE : mixHex(String(res.color), '#06050C', 0.72);
          res.label = '';
          res.zIndex = 0;
        }
      }
      if (node === selectedId) {
        res.highlighted = true;
        res.zIndex = 4;
        res.size = Number(data.size) + 2;
      }
      return res;
    });

    sigma.setSetting('edgeReducer', (edge, data) => {
      const res: Record<string, unknown> = { ...data };
      const source = graph.source(edge);
      const target = graph.target(edge);
      const sk = graph.getNodeAttribute(source, 'kind');
      const tk = graph.getNodeAttribute(target, 'kind');
      if (
        (sk !== '__core' && hidden.has(String(sk))) ||
        (tk !== '__core' && hidden.has(String(tk)))
      ) {
        res.hidden = true;
        return res;
      }
      if (spotlight) {
        if (spotlight.has(source) && spotlight.has(target)) {
          res.color = hexToRgba(String(data.communityColor), 0.75);
          res.size = 1.3;
          res.zIndex = 2;
        } else {
          res.hidden = true;
        }
        return res;
      }
      if (data.sameCommunity) {
        res.color = hexToRgba(
          String(data.communityColor),
          Math.min(0.85, 0.2 * settings.edgeOpacity),
        );
      } else {
        if (!settings.interGalaxy) {
          res.hidden = true;
          return res;
        }
        res.color = `rgba(196,180,220,${Math.min(0.5, 0.05 * settings.edgeOpacity)})`;
      }
      return res;
    });

    sigma.refresh({ skipIndexation: true });
  }, [
    sigma,
    build,
    hovered,
    selectedId,
    settings.viewBy,
    settings.hiddenKinds,
    settings.edgeOpacity,
    settings.interGalaxy,
    settings.galaxyLabels,
  ]);

  return null;
}
