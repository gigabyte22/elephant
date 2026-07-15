import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/react-sigma.min.css';
import Graph, { MultiGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useEffect, useMemo } from 'react';
import type { GraphNeighborhoodPayload } from '../../api/types.ts';
import { truncateText } from '../../lib/format.ts';
import { styleForKind } from '../../lib/kindStyle.ts';

// Sigma renderer for a neighborhood payload. The graph is rebuilt whenever
// the payload reference changes; layout is computed by ForceAtlas2 with a
// short iteration count so even larger neighborhoods land within a frame.
// Root node is fixed at the canvas center; everything else lays out around
// it.

interface Props {
  payload: GraphNeighborhoodPayload | undefined;
  onSelect: (nodeId: string) => void;
  selectedId: string | null;
}

export function GraphCanvas({ payload, onSelect, selectedId }: Props) {
  return (
    <SigmaContainer
      graph={MultiGraph}
      style={{ background: 'transparent', height: '100%', width: '100%' }}
      settings={{
        defaultEdgeColor: 'rgba(255,196,225,0.18)',
        labelColor: { color: '#A4A0B5' },
        labelSize: 11,
        labelFont: '"JetBrains Mono", ui-monospace, monospace',
        labelWeight: '500',
        labelDensity: 0.6,
        renderEdgeLabels: false,
        defaultNodeType: 'circle',
        nodeReducer: (nodeId, data) => {
          if (nodeId === selectedId) {
            return { ...data, highlighted: true, zIndex: 2 };
          }
          return data;
        },
      }}
    >
      <Loader payload={payload} selectedId={selectedId} />
      <ClickHandler onSelect={onSelect} />
    </SigmaContainer>
  );
}

function Loader({
  payload,
  selectedId,
}: {
  payload: GraphNeighborhoodPayload | undefined;
  selectedId: string | null;
}) {
  const loadGraph = useLoadGraph();
  const sigma = useSigma();

  const graph = useMemo(() => {
    if (!payload) return null;
    const g = new Graph({ multi: true });
    for (const node of payload.nodes) {
      const style = styleForKind(node.kind);
      g.addNode(node.id, {
        label: truncateText(node.label || node.id, 28),
        size: node.id === payload.rootId ? style.size + 4 : style.size,
        color: style.color,
        x: Math.random(),
        y: Math.random(),
        kind: node.kind,
      });
    }
    // Anchor the root at the origin before layout so neighbors radiate.
    if (g.hasNode(payload.rootId)) {
      g.setNodeAttribute(payload.rootId, 'x', 0);
      g.setNodeAttribute(payload.rootId, 'y', 0);
    }
    for (const edge of payload.edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue;
      if (g.hasEdge(edge.id)) continue;
      g.addEdgeWithKey(edge.id, edge.source, edge.target, {
        size: 0.6,
        type: 'line',
        label: edge.type,
      });
    }
    // Short iteration count — neighborhood graphs are small (≤150 nodes).
    forceAtlas2.assign(g, {
      iterations: 120,
      settings: {
        gravity: 0.6,
        scalingRatio: 6,
        slowDown: 4,
        barnesHutOptimize: payload.nodes.length > 60,
      },
    });
    return g;
  }, [payload]);

  useEffect(() => {
    if (!graph) return;
    loadGraph(graph);
    // Center the camera on the root after load.
    if (payload && graph.hasNode(payload.rootId)) {
      requestAnimationFrame(() => {
        sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1.1 }, { duration: 240 });
      });
    }
  }, [graph, loadGraph, sigma, payload]);

  useEffect(() => {
    if (!selectedId) return;
    sigma.refresh();
  }, [selectedId, sigma]);

  return null;
}

function ClickHandler({ onSelect }: { onSelect: (id: string) => void }) {
  const registerEvents = useRegisterEvents();
  useEffect(() => {
    registerEvents({
      clickNode: (event) => onSelect(event.node),
    });
  }, [registerEvents, onSelect]);
  return null;
}
