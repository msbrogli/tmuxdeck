import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Settings,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  AlertTriangle,
  Camera,
  Radio,
} from 'lucide-react';
import { api } from '../api/client';
import { ContainerNode } from './ContainerNode';
import { NewContainerDialog } from './NewContainerDialog';
import { RestoreDialog } from './RestoreDialog';
import { WorkspaceTabs } from './WorkspaceTabs';
import { WorkspaceAddMemberDialog } from './WorkspaceAddMemberDialog';
import type { Container, SessionTarget, Selection } from '../types';
import { getSidebarCollapsed, saveSidebarCollapsed, getSectionsCollapsed, saveSectionsCollapsed, getActiveWorkspaceId, saveActiveWorkspaceId } from '../utils/sidebarState';
import { filterWorkspace, type FilterResult } from '../utils/workspaceFilter';

const CONTAINER_DRAG_MIME = 'application/x-container-order';

interface SidebarProps {
  collapsed?: boolean;
  selectedSession?: Selection | null;
  previewSession?: SessionTarget | null;
  onSelectSession?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewSession?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewEnd?: () => void;
  digitByTargetKey?: Record<string, string>;
  assignDigit?: (digit: string, target: SessionTarget) => void;
  isSessionExpanded?: (containerId: string, sessionId: string) => boolean;
  setSessionExpanded?: (containerId: string, sessionId: string, expanded: boolean) => void;
  isContainerExpanded?: (containerId: string) => boolean;
  setContainerExpanded?: (containerId: string, expanded: boolean) => void;
}

const SIDEBAR_WIDTH_KEY = 'sidebar-width';
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 288;

function getSavedSidebarWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) return n;
    }
  } catch {}
  return SIDEBAR_DEFAULT_WIDTH;
}

export function Sidebar({ collapsed: initialCollapsed, selectedSession, previewSession, onSelectSession, onPreviewSession, onPreviewEnd, digitByTargetKey, assignDigit, isSessionExpanded, setSessionExpanded, isContainerExpanded, setContainerExpanded }: SidebarProps) {
  const [collapsed, setCollapsedRaw] = useState(() => initialCollapsed ?? getSidebarCollapsed());
  const setCollapsed = (v: boolean) => { setCollapsedRaw(v); saveSidebarCollapsed(v); };
  const [sidebarWidth, setSidebarWidth] = useState(getSavedSidebarWidth);
  const isResizing = useRef(false);
  const [showNewContainer, setShowNewContainer] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [sectionsCollapsed, setSectionsCollapsedRaw] = useState<Record<string, boolean>>(getSectionsCollapsed);
  const setSectionsCollapsed = (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    setSectionsCollapsedRaw((prev) => { const next = updater(prev); saveSectionsCollapsed(next); return next; });
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isMainPage = location.pathname === '/';

  // Auto-scroll sidebar to keep keyboard-selected item visible
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !selectedSession) return;
    const el = container.querySelector('[data-selected="true"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedSession]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save final width
      setSidebarWidth((w) => { try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch {} return w; });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // When not on main page, clicking a session window navigates to main with selection
  const handleSelectSession = onSelectSession ?? ((containerId: string, sessionName: string, windowIndex: number) => {
    navigate('/', { state: { selectSession: { containerId, sessionName, windowIndex } } });
  });

  const { data, error, refetch } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.listContainers(),
    retry: 2,
    refetchInterval: 3000,
  });

  const { data: containerOrder = [] } = useQuery({
    queryKey: ['containerOrder'],
    queryFn: () => api.getContainerOrder(),
    staleTime: 30_000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
    staleTime: 60_000,
  });

  const queryClient = useQueryClient();

  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.listWorkspaces(),
    staleTime: 30_000,
  });

  const workspaces = workspacesData?.workspaces ?? [];
  const workspaceOrder = workspacesData?.workspaceOrder ?? [];

  const [activeWorkspaceId, setActiveWorkspaceIdRaw] = useState(getActiveWorkspaceId);
  const setActiveWorkspaceId = (id: string) => {
    setActiveWorkspaceIdRaw(id);
    saveActiveWorkspaceId(id);
  };

  // Sync workspace ID when changed externally (e.g., Ctrl+digit shortcut)
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setActiveWorkspaceIdRaw(id);
    };
    window.addEventListener('workspace-changed', handler);
    return () => window.removeEventListener('workspace-changed', handler);
  }, []);

  // If active workspace was deleted, fall back to "all"
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces.find((w) => w.isDefault);

  const snapshotEnabled = settings?.snapshotEnabled ?? true;

  const { containers = [], dockerError } = data ?? {};

  // Apply saved order, falling back to default grouping: special → running → stopped
  const orderedContainers = useMemo(() => {
    if (containerOrder.length === 0) {
      const special = containers.filter((c) => c.containerType === 'host' || c.containerType === 'local' || c.containerType === 'bridge');
      const running = containers.filter((c) => c.status === 'running' && !special.includes(c));
      const stopped = containers.filter((c) => c.status !== 'running' && !special.includes(c));
      return [...special, ...running, ...stopped];
    }
    const orderMap = new Map(containerOrder.map((id, idx) => [id, idx]));
    return [...containers].sort((a, b) => {
      const ia = orderMap.get(a.id) ?? Infinity;
      const ib = orderMap.get(b.id) ?? Infinity;
      if (ia === Infinity && ib === Infinity) {
        // Fallback: special first, then running, then stopped
        const rank = (c: Container) => {
          if (c.containerType === 'local' || c.containerType === 'host' || c.containerType === 'bridge') return 0;
          if (c.status === 'running') return 1;
          return 2;
        };
        return rank(a) - rank(b);
      }
      return ia - ib;
    });
  }, [containers, containerOrder]);

  // Workspace filtering
  const filterResult = useMemo<FilterResult | null>(() => {
    if (!activeWorkspace || activeWorkspace.isDefault) return null;
    return filterWorkspace(activeWorkspace.members, containers);
  }, [activeWorkspace, containers]);

  const displayedContainers = useMemo(() => {
    if (!filterResult) return orderedContainers;
    return orderedContainers.filter((c) => filterResult.visibleContainerIds.has(c.id));
  }, [orderedContainers, filterResult]);

  const handleCreateWorkspace = useCallback(async (name: string) => {
    await api.createWorkspace(name);
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  }, [queryClient]);

  const handleUpdateWorkspaceMembers = useCallback(async (members: import('../types').WorkspaceMember[]) => {
    if (!activeWorkspace || activeWorkspace.isDefault) return;
    await api.updateWorkspace(activeWorkspace.id, { members });
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  }, [activeWorkspace, queryClient]);

  const [dragOverContainerId, setDragOverContainerId] = useState<string | null>(null);

  const handleContainerReorder = useCallback((fromId: string, toId: string) => {
    const currentIds = orderedContainers.map((c) => c.id);
    const fromIdx = currentIds.indexOf(fromId);
    const toIdx = currentIds.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const newOrder = [...currentIds];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, fromId);
    api.saveContainerOrder(newOrder);
  }, [orderedContainers]);

  if (collapsed) {
    return (
      <div className="w-12 bg-gray-900 border-r border-gray-800 flex flex-col items-center py-3 gap-2 shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={18} />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => navigate('/settings')}
          className={`p-1.5 rounded hover:bg-gray-800 transition-colors ${
            location.pathname.startsWith('/settings') ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200'
          }`}
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 relative" style={{ width: sidebarWidth }}>
        <div className="flex items-center justify-between px-3 py-3 border-b border-gray-800">
          <button
            onClick={() => navigate('/')}
            className="font-semibold text-sm text-gray-200 hover:text-white transition-colors"
          >
            TmuxDeck <span className="text-[10px] font-normal text-gray-600">v1.0</span>
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowNewContainer(true)}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              title="New Container"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => setCollapsed(true)}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
        </div>

        <WorkspaceTabs
          workspaces={workspaces}
          workspaceOrder={workspaceOrder}
          activeId={activeWorkspace?.id ?? 'all'}
          onSelect={setActiveWorkspaceId}
          onCreate={handleCreateWorkspace}
          onAddMember={activeWorkspace && !activeWorkspace.isDefault ? () => setShowAddMember(true) : undefined}
        />

        <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
          {error && (
            <div className="mx-2 mb-2 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800/50">
              <div className="flex items-center gap-2 text-red-400 text-xs font-medium">
                <AlertTriangle size={13} className="shrink-0" />
                Backend error
              </div>
              <p className="text-[11px] text-red-400/70 mt-1">
                {error instanceof Error ? error.message : 'Could not connect to backend'}
              </p>
              <button
                onClick={() => refetch()}
                className="text-[11px] text-red-300 hover:text-red-200 mt-1.5 underline"
              >
                Retry
              </button>
            </div>
          )}
          {dockerError && (
            <div className="mx-2 mb-2 px-3 py-2 rounded-lg bg-yellow-900/30 border border-yellow-800/50">
              <div className="flex items-center gap-2 text-yellow-400 text-xs font-medium">
                <AlertTriangle size={13} className="shrink-0" />
                Docker unavailable
              </div>
              <p className="text-[11px] text-yellow-400/70 mt-1">
                {dockerError}
              </p>
            </div>
          )}
          {displayedContainers.map((container) => {
            const isSpecial = container.containerType === 'host' || container.containerType === 'local' || container.containerType === 'bridge';
            const sectionKey = container.containerType === 'bridge' ? container.id : (container.containerType ?? 'special');
            return (
              <div
                key={container.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(CONTAINER_DRAG_MIME, container.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(CONTAINER_DRAG_MIME)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverContainerId(container.id);
                }}
                onDragLeave={() => setDragOverContainerId(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverContainerId(null);
                  const fromId = e.dataTransfer.getData(CONTAINER_DRAG_MIME);
                  if (fromId && fromId !== container.id) {
                    handleContainerReorder(fromId, container.id);
                  }
                }}
                className={dragOverContainerId === container.id ? 'border-t-2 border-blue-500' : 'border-t-2 border-transparent'}
              >
                <ContainerNode
                  container={container}
                  selectedSession={selectedSession}
                  previewSession={previewSession}
                  onSelectSession={handleSelectSession}
                  onPreviewSession={isMainPage ? onPreviewSession : undefined}
                  onPreviewEnd={isMainPage ? onPreviewEnd : undefined}
                  onRefresh={refetch}
                  digitByTargetKey={digitByTargetKey}
                  assignDigit={assignDigit}
                  isSessionExpanded={isSessionExpanded}
                  setSessionExpanded={setSessionExpanded}
                  isContainerExpanded={isContainerExpanded}
                  setContainerExpanded={setContainerExpanded}
                  sectionCollapsed={isSpecial ? sectionsCollapsed[sectionKey] : undefined}
                  onToggleSection={isSpecial ? () => setSectionsCollapsed((s) => ({ ...s, [sectionKey]: !s[sectionKey] })) : undefined}
                  filterResult={filterResult}
                  workspaces={workspaces}
                  activeWorkspace={activeWorkspace}
                />
              </div>
            );
          })}
          {/* Offline workspace members */}
          {filterResult?.offlineMembers.map((member) => (
            <div key={member.sourceId} className="px-2 py-0.5 opacity-50">
              <div className="flex items-center gap-1.5">
                <Radio size={14} className="text-gray-500 shrink-0" />
                <span className="text-sm text-gray-500 truncate">
                  {member.displayName} offline
                </span>
              </div>
            </div>
          ))}
          {containers.length === 0 && (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">
              No containers yet.
              <br />
              <button
                onClick={() => setShowNewContainer(true)}
                className="text-blue-400 hover:text-blue-300 mt-2 inline-block"
              >
                Create one
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-gray-800 p-2 flex flex-col gap-1">
          <button
            onClick={() => navigate('/settings')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
              location.pathname === '/settings' || location.pathname === '/settings/templates'
                ? 'bg-gray-800 text-blue-400'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
            }`}
          >
            <Settings size={15} />
            Settings
          </button>
          {snapshotEnabled && (
            <button
              onClick={() => setShowRestore(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors text-gray-400 hover:text-gray-200 hover:bg-gray-800"
            >
              <Camera size={15} />
              Snapshot
              {((data?.missingSnapshotSessions ?? 0) + (data?.driftedSnapshotSessions ?? 0)) > 0 && (
                <span className="ml-auto bg-orange-600 text-white text-xs font-medium px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {(data?.missingSnapshotSessions ?? 0) + (data?.driftedSnapshotSessions ?? 0)}
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => navigate('/settings/help')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
              location.pathname === '/settings/help'
                ? 'bg-gray-800 text-blue-400'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
            }`}
          >
            <HelpCircle size={15} />
            Help
          </button>
        </div>

        {/* Resize drag handle */}
        <div
          onMouseDown={handleResizeStart}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500/40 transition-colors"
        />
      </div>

      {showNewContainer && (
        <NewContainerDialog
          onClose={() => setShowNewContainer(false)}
          onCreated={() => {
            setShowNewContainer(false);
            refetch();
          }}
        />
      )}

      {showRestore && (
        <RestoreDialog onClose={() => setShowRestore(false)} />
      )}

      {showAddMember && activeWorkspace && !activeWorkspace.isDefault && (
        <WorkspaceAddMemberDialog
          workspace={activeWorkspace}
          containers={containers}
          onClose={() => setShowAddMember(false)}
          onUpdateMembers={handleUpdateWorkspaceMembers}
        />
      )}
    </>
  );
}
