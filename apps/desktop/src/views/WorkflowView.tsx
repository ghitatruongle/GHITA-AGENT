import { useState, useRef, useEffect } from 'react';
import { useTranslation } from '../i18n';
import { Button } from '../components/ui';

interface WorkflowNode {
  id: string;
  type: 'start' | 'tool' | 'command' | 'condition' | 'loop' | 'end';
  title: string;
  x: number;
  y: number;
  config: Record<string, string>;
}

interface WorkflowConnection {
  fromId: string;
  toId: string;
  fromPort: 'output' | 'yes' | 'no';
  toPort: 'input';
}

const getDefaultNodes = (t: (key: string) => string): WorkflowNode[] => [
  {
    id: 'node-start',
    type: 'start',
    title: `🏁 ${t('workflow.startPipeline')}`,
    x: 60,
    y: 180,
    config: { trigger: 'Git Push Event' },
  },
  {
    id: 'node-test',
    type: 'command',
    title: `💻 ${t('workflow.runUnitTests')}`,
    x: 240,
    y: 180,
    config: { command: 'pnpm test --passWithNoTests' },
  },
  {
    id: 'node-check',
    type: 'condition',
    title: `❓ ${t('workflow.testsPassed')}`,
    x: 430,
    y: 170,
    config: { condition: 'exitCode === 0' },
  },
  {
    id: 'node-deploy',
    type: 'tool',
    title: `🚀 ${t('workflow.deployVercel')}`,
    x: 640,
    y: 70,
    config: { tool: 'vercel-deploy', environment: 'production' },
  },
  {
    id: 'node-fix',
    type: 'tool',
    title: `🛠️ ${t('workflow.triggerAutoFix')}`,
    x: 640,
    y: 280,
    config: { prompt: 'Fix the failed tests in sandbox environment' },
  },
];

const DEFAULT_CONNECTIONS: WorkflowConnection[] = [
  { fromId: 'node-start', toId: 'node-test', fromPort: 'output', toPort: 'input' },
  { fromId: 'node-test', toId: 'node-check', fromPort: 'output', toPort: 'input' },
  { fromId: 'node-check', toId: 'node-deploy', fromPort: 'yes', toPort: 'input' },
  { fromId: 'node-check', toId: 'node-fix', fromPort: 'no', toPort: 'input' },
];

export function WorkflowView() {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<WorkflowNode[]>(getDefaultNodes(t));
  const [connections, setConnections] = useState<WorkflowConnection[]>(DEFAULT_CONNECTIONS);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const [linkingFrom, setLinkingFrom] = useState<{
    nodeId: string;
    port: 'output' | 'yes' | 'no';
  } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // the rubber-band persisted until a successful drop, blocking node drag).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkingFrom(null);
        setDraggingNodeId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleNodeMouseDown = (e: React.MouseEvent, node: WorkflowNode) => {
    if (linkingFrom) return;
    setSelectedNodeId(node.id);
    setDraggingNodeId(node.id);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.stopPropagation();
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    // `getBoundingClientRect()` trả toạ độ viewport; canvas là overflow-auto
    // nên phải cộng thêm scrollLeft/scrollTop, nếu không kéo càng xa càng lệch.
    const scrollX = canvasRef.current.scrollLeft;
    const scrollY = canvasRef.current.scrollTop;
    if (draggingNodeId) {
      const x = Math.max(
        10,
        Math.min(2000, e.clientX - canvasRect.left + scrollX - dragOffsetRef.current.x),
      );
      const y = Math.max(
        10,
        Math.min(1000, e.clientY - canvasRect.top + scrollY - dragOffsetRef.current.y),
      );
      setNodes((prev) => prev.map((n) => (n.id === draggingNodeId ? { ...n, x, y } : n)));
    }
    if (linkingFrom) {
      setMousePos({
        x: e.clientX - canvasRect.left + scrollX,
        y: e.clientY - canvasRect.top + scrollY,
      });
    }
  };

  const handleCanvasMouseUp = () => setDraggingNodeId(null);

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!canvasRef.current) return;
    const type = e.dataTransfer.getData('nodeType') as WorkflowNode['type'];
    if (!type) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(10, e.clientX - canvasRect.left + canvasRef.current.scrollLeft - 80);
    const y = Math.max(10, e.clientY - canvasRect.top + canvasRef.current.scrollTop - 24);
    const newNode: WorkflowNode = {
      id: `node-${Date.now()}`,
      type,
      title: getPlaceholderTitle(type),
      x,
      y,
      config: getDefaultConfig(type),
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
  };

  const getPlaceholderTitle = (type: WorkflowNode['type']) => {
    switch (type) {
      case 'start':
        return `🏁 ${t('workflow.startTrigger')}`;
      case 'tool':
        return `🔌 ${t('workflow.callMcpTool')}`;
      case 'command':
        return `💻 ${t('workflow.runCommand')}`;
      case 'condition':
        return `❓ ${t('workflow.conditionalCheck')}`;
      case 'loop':
        return `🔄 ${t('workflow.repeatLoop')}`;
      case 'end':
        return `🎯 ${t('workflow.endNode')}`;
    }
  };

  const getDefaultConfig = (type: WorkflowNode['type']): Record<string, string> => {
    switch (type) {
      case 'start':
        return { trigger: 'Manual Run' };
      case 'tool':
        return { tool: 'file-writer', target: 'index.ts' };
      case 'command':
        return { command: 'npm run lint' };
      case 'condition':
        return { condition: 'success === true' };
      case 'loop':
        return { maxIterations: '5' };
      case 'end':
        return { message: 'Successfully Completed' };
    }
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== canvasRef.current || !canvasRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    // Như handleDrop: cộng scroll để node rơi đúng chỗ dưới con trỏ kể cả khi
    // canvas đã cuộn.
    const x = e.clientX - canvasRect.left + canvasRef.current.scrollLeft - 80;
    const y = e.clientY - canvasRect.top + canvasRef.current.scrollTop - 24;
    const newNode: WorkflowNode = {
      id: `node-${Date.now()}`,
      type: 'command',
      title: '💻 New Exec Step',
      x,
      y,
      config: { command: 'echo "hello"' },
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
  };

  const handleStartLink = (e: React.MouseEvent, nodeId: string, port: 'output' | 'yes' | 'no') => {
    e.stopPropagation();
    if (!canvasRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    setLinkingFrom({ nodeId, port });
    // Cộng scroll ngay từ đầu, nếu không đường nối preview nhảy một đoạn
    // bằng đúng mức cuộn cho tới khi mousemove đầu tiên chạy.
    setMousePos({
      x: e.clientX - canvasRect.left + canvasRef.current.scrollLeft,
      y: e.clientY - canvasRect.top + canvasRef.current.scrollTop,
    });
  };

  // Kết nối từ `from` vào `to` tạo chu trình nếu `to` là tổ tiên của `from`.
  const wouldCreateCycle = (from: string, to: string, edges: WorkflowConnection[]): boolean => {
    const parents = new Map<string, string[]>();
    for (const e of edges) {
      const list = parents.get(e.toId) ?? [];
      list.push(e.fromId);
      parents.set(e.toId, list);
    }
    const seen = new Set<string>([to]);
    const stack = [to];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined) break;
      if (cur === from) return true;
      for (const p of parents.get(cur) ?? []) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return false;
  };

  const handleConnect = (e: React.MouseEvent, toNodeId: string) => {
    e.stopPropagation();
    if (!linkingFrom) return;
    if (linkingFrom.nodeId !== toNodeId) {
      if (wouldCreateCycle(linkingFrom.nodeId, toNodeId, connections)) {
        // Phải thoát chế độ nối, nếu không đường nối vàng kẹt theo con trỏ và
        // không kéo được node nào cho tới khi bấm Escape.
        setLinkingFrom(null);
        return;
      }
      setConnections((prev) =>
        prev
          .filter((c) => !(c.fromId === linkingFrom.nodeId && c.fromPort === linkingFrom.port))
          .concat({
            fromId: linkingFrom.nodeId,
            toId: toNodeId,
            fromPort: linkingFrom.port,
            toPort: 'input',
          }),
      );
    }
    setLinkingFrom(null);
  };

  const deleteNode = (nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setConnections((prev) => prev.filter((c) => c.fromId !== nodeId && c.toId !== nodeId));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  };

  const clearCanvas = () => {
    setNodes([]);
    setConnections([]);
    setSelectedNodeId(null);
  };

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  const compileWorkflowJSON = () => {
    const data = {
      name: 'GHITA Custom Pipeline',
      compiledAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, title: n.title, config: n.config })),
      edges: connections.map((c) => ({ source: c.fromId, target: c.toId, route: c.fromPort })),
    };
    return JSON.stringify(data, null, 2);
  };

  return (
    <div className="flex h-full bg-slate-900/45 backdrop-blur-2xl text-slate-50 font-sans">
      {/* Canvas CSS helpers */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .canvas-grid {
          background-size: 24px 24px;
          background-image:
            linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
        }
        .canvas-node {
          background: rgba(30,41,59,0.7); backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .canvas-node:hover { border-color: rgba(99,102,241,0.4); }
        .canvas-node.selected { border-color: #6366f1; box-shadow: 0 0 14px rgba(99,102,241,0.3); }
        .node-port {
          width: 10px; height: 10px; background: #6366f1; border-radius: 50%;
          border: 2px solid #0f172a; cursor: crosshair; transition: transform 0.1s;
        }
        .node-port:hover { transform: scale(1.4); }
        .drawer-item {
          padding: 10px 12px; border-radius: 8px; background: rgba(15,23,42,0.5);
          border: 1px solid rgba(255,255,255,0.05); font-size: 12px; font-weight: 600;
          color: #e2e8f0; cursor: grab; display: flex; align-items: center; gap: 8px;
          transition: background 0.2s, border-color 0.2s;
        }
        .drawer-item:hover { background: rgba(99,102,241,0.1); border-color: rgba(99,102,241,0.3); }
      `,
        }}
      />

      {/* Sidebar Tool Drawer */}
      <div className="w-60 border-r border-white/5 bg-slate-800/40 p-4 flex flex-col gap-4 shrink-0">
        <div>
          <h3 className="m-0 mb-1.5 text-sm font-bold tracking-wide text-indigo-200">
            🧩 {t('workflow.dragNodes')}
          </h3>
          <p className="m-0 text-[11px] text-slate-400">{t('workflow.dragNodesDesc')}</p>
        </div>

        <div className="flex flex-col gap-2.5">
          {(['start', 'command', 'tool', 'condition', 'loop', 'end'] as const).map((type) => (
            <div
              key={type}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('nodeType', type)}
              className="drawer-item"
            >
              <span>
                {type === 'start' && '🏁'}
                {type === 'command' && '💻'}
                {type === 'tool' && '🔌'}
                {type === 'condition' && '❓'}
                {type === 'loop' && '🔄'}
                {type === 'end' && '🎯'}
              </span>
              <span>
                {type === 'start' && t('workflow.startTrigger')}
                {type === 'command' && t('workflow.runCommand')}
                {type === 'tool' && t('workflow.callMcpTool')}
                {type === 'condition' && t('workflow.conditionalCheck')}
                {type === 'loop' && t('workflow.repeatLoop')}
                {type === 'end' && t('workflow.endNode')}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="text-indigo-300 bg-indigo-500/10 border-indigo-500/30"
            onClick={() => {
              setNodes(getDefaultNodes(t));
              setConnections(DEFAULT_CONNECTIONS);
              setSelectedNodeId(null);
            }}
          >
            🔄 {t('workflow.resetDemo')}
          </Button>
          <Button size="sm" variant="danger" onClick={clearCanvas}>
            🗑️ {t('workflow.clearCanvas')}
          </Button>
        </div>
      </div>

      {/* Main Canvas Area */}
      <div
        className="flex-1 flex flex-col overflow-hidden relative"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Canvas Toolbar */}
        <div className="px-5 py-3 border-b border-white/5 bg-slate-800/25 flex items-center justify-between z-30">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎨</span>
            <span className="font-bold text-[13px] tracking-wide">
              {t('workflow.visualCanvas')}
            </span>
            <span className="text-[11px] text-slate-400 bg-white/5 px-2 py-0.5 rounded">
              {t('workflow.doubleClickHint')}
            </span>
          </div>
          <div className="flex gap-2.5">
            <span className="text-[11px] text-indigo-400 font-semibold">
              {t('workflow.activeSteps')} {nodes.length}
            </span>
            <span className="text-[11px] text-emerald-400 font-semibold">
              {t('workflow.connections')} {connections.length}
            </span>
          </div>
        </div>

        {/* Scrollable grid canvas */}
        <div
          ref={canvasRef}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onDoubleClick={handleCanvasDoubleClick}
          className="canvas-grid flex-1 relative overflow-auto bg-[#090d16]"
        >
          {/* SVG Connector lines */}
          <svg className="absolute top-0 left-0 w-[2000px] h-[1000px] pointer-events-none z-[2]">
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="#818cf8" />
              </marker>
            </defs>
            {connections.map((c, index) => {
              const fromNode = nodes.find((n) => n.id === c.fromId);
              const toNode = nodes.find((n) => n.id === c.toId);
              if (!fromNode || !toNode) return null;
              const fromWidth = 160;
              const fromHeight = fromNode.type === 'condition' ? 76 : 58;
              const outX = fromNode.x + fromWidth;
              let outY = fromNode.y + fromHeight / 2;
              if (fromNode.type === 'condition') {
                if (c.fromPort === 'yes') outY = fromNode.y + 24;
                else if (c.fromPort === 'no') outY = fromNode.y + 52;
              }
              const inX = toNode.x;
              const toHeight = toNode.type === 'condition' ? 76 : 58;
              const inY = toNode.y + toHeight / 2;
              const dx = Math.abs(inX - outX) * 0.4;
              const pathStr = `M ${outX} ${outY} C ${outX + dx} ${outY}, ${inX - dx} ${inY}, ${inX} ${inY}`;
              return (
                <path
                  key={index}
                  d={pathStr}
                  fill="none"
                  stroke={
                    c.fromPort === 'no' ? '#f43f5e' : c.fromPort === 'yes' ? '#10b981' : '#818cf8'
                  }
                  strokeWidth="2"
                  markerEnd="url(#arrow)"
                  className="opacity-85"
                />
              );
            })}
            {linkingFrom &&
              (() => {
                const fromNode = nodes.find((n) => n.id === linkingFrom.nodeId);
                if (!fromNode) return null;
                const fromWidth = 160;
                const fromHeight = fromNode.type === 'condition' ? 76 : 58;
                const outX = fromNode.x + fromWidth;
                let outY = fromNode.y + fromHeight / 2;
                if (fromNode.type === 'condition') {
                  if (linkingFrom.port === 'yes') outY = fromNode.y + 24;
                  else if (linkingFrom.port === 'no') outY = fromNode.y + 52;
                }
                const dx = Math.abs(mousePos.x - outX) * 0.4;
                const pathStr = `M ${outX} ${outY} C ${outX + dx} ${outY}, ${mousePos.x - dx} ${mousePos.y}, ${mousePos.x} ${mousePos.y}`;
                return (
                  <path
                    d={pathStr}
                    fill="none"
                    stroke="#fbbf24"
                    strokeWidth="2"
                    strokeDasharray="4 4"
                  />
                );
              })()}
          </svg>

          {/* Render workflow nodes */}
          {nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const isCondition = node.type === 'condition';
            return (
              <div
                key={node.id}
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                onClick={(e) => {
                  setSelectedNodeId(node.id);
                  e.stopPropagation();
                }}
                className={`canvas-node ${isSelected ? 'selected' : ''}`}
                style={{
                  position: 'absolute',
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: '160px',
                  zIndex: 10,
                  cursor: 'move',
                  userSelect: 'none',
                }}
              >
                {/* Drag Header */}
                <div className="px-2.5 py-2 text-[11px] font-bold border-b border-white/5 bg-white/[0.02] flex justify-between items-center rounded-t-lg">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                    {node.title}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteNode(node.id);
                    }}
                    className="border-none bg-none text-red-400/60 text-[10px] cursor-pointer hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
                {/* Node details */}
                <div className="px-2.5 py-2 text-[10px] text-slate-400">
                  {node.type === 'start' && `Trigger: ${node.config.trigger || ''}`}
                  {node.type === 'command' && `CMD: ${node.config.command || ''}`}
                  {node.type === 'tool' && `Tool: ${node.config.tool || ''}`}
                  {node.type === 'condition' && `IF: ${node.config.condition || ''}`}
                  {node.type === 'loop' && `Loops: ${node.config.maxIterations || '5'}`}
                  {node.type === 'end' && `Msg: ${node.config.message || ''}`}
                </div>
                {/* Left Input Port */}
                {node.type !== 'start' && (
                  <div
                    onMouseUp={(e) => handleConnect(e, node.id)}
                    className="node-port absolute"
                    style={{ left: '-6px', top: isCondition ? '33px' : '24px' }}
                    title="Connect target input"
                  />
                )}
                {/* Right Output Ports */}
                {isCondition ? (
                  <>
                    <div
                      onMouseDown={(e) => handleStartLink(e, node.id, 'yes')}
                      className="node-port absolute"
                      style={{ right: '-6px', top: '19px', background: '#10b981' }}
                      title="Branch: YES"
                    />
                    <span className="absolute right-2 top-[15px] text-[8px] text-emerald-500 font-semibold">
                      YES
                    </span>
                    <div
                      onMouseDown={(e) => handleStartLink(e, node.id, 'no')}
                      className="node-port absolute"
                      style={{ right: '-6px', top: '47px', background: '#f43f5e' }}
                      title="Branch: NO"
                    />
                    <span className="absolute right-2 top-[43px] text-[8px] text-rose-500 font-semibold">
                      NO
                    </span>
                  </>
                ) : (
                  node.type !== 'end' && (
                    <div
                      onMouseDown={(e) => handleStartLink(e, node.id, 'output')}
                      className="node-port absolute"
                      style={{ right: '-6px', top: '24px' }}
                      title="Connect next step"
                    />
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Configuration Sidebar Panel */}
      <div className="w-[280px] border-l border-white/5 bg-slate-800/40 p-4 flex flex-col gap-4 shrink-0">
        <h3 className="m-0 text-[13px] font-bold text-indigo-200 tracking-wide">
          ⚙️ {t('workflow.configPanel')}
        </h3>

        {selectedNode ? (
          <div className="flex flex-col gap-3.5 flex-1">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-slate-400">{t('workflow.stepTitle')}</label>
              <input
                type="text"
                value={selectedNode.title}
                onChange={(e) => {
                  const val = e.target.value;
                  setNodes((prev) =>
                    prev.map((n) => (n.id === selectedNode.id ? { ...n, title: val } : n)),
                  );
                }}
                className="px-2.5 py-2 text-xs rounded-md bg-slate-900/60 border border-white/10 text-slate-50 outline-none focus:border-indigo-500/50"
              />
            </div>

            {Object.keys(selectedNode.config).map((key) => (
              <div key={key} className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400 capitalize">{key}:</label>
                <input
                  type="text"
                  value={selectedNode.config[key] || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setNodes((prev) =>
                      prev.map((n) =>
                        n.id === selectedNode.id
                          ? { ...n, config: { ...n.config, [key]: val } }
                          : n,
                      ),
                    );
                  }}
                  className="px-2.5 py-2 text-xs rounded-md bg-slate-900/60 border border-white/10 text-slate-50 outline-none font-mono focus:border-indigo-500/50"
                />
              </div>
            ))}

            <div className="mt-2.5 px-3 py-2 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-[11px] text-indigo-300">
              💡 <strong>Tip:</strong> {t('workflow.tip')}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-xs text-center">
            {t('workflow.selectNodeHint')}
          </div>
        )}

        {/* JSON Code Compile Preview */}
        <div className="flex flex-col gap-1.5 border-t border-white/5 pt-4">
          <span className="text-[11px] text-slate-400 font-semibold">
            {t('workflow.compiledJson')}
          </span>
          <pre className="m-0 p-2.5 rounded-lg bg-[#090d16] border border-white/5 text-[10px] font-mono text-sky-400 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {compileWorkflowJSON()}
          </pre>
        </div>
      </div>
    </div>
  );
}
