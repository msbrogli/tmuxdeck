import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Plus,
  Settings,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client';
import { ContainerNode } from './ContainerNode';
import { NewContainerDialog } from './NewContainerDialog';
import type { SessionTarget, Selection } from '../types';
import { getSidebarCollapsed, saveSidebarCollapsed, getSectionsCollapsed, saveSectionsCollapsed } from '../utils/sidebarState';

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
}

export function Sidebar({ collapsed: initialCollapsed, selectedSession, previewSession, onSelectSession, onPreviewSession, onPreviewEnd, digitByTargetKey, assignDigit, isSessionExpanded, setSessionExpanded }: SidebarProps) {
  const [collapsed, setCollapsedRaw] = useState(() => initialCollapsed ?? getSidebarCollapsed());
  const setCollapsed = (v: boolean) => { setCollapsedRaw(v); saveSidebarCollapsed(v); };
  const [showNewContainer, setShowNewContainer] = useState(false);
  const [sectionsCollapsed, setSectionsCollapsedRaw] = useState<Record<string, boolean>>(getSectionsCollapsed);
  const setSectionsCollapsed = (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    setSectionsCollapsedRaw((prev) => { const next = updater(prev); saveSectionsCollapsed(next); return next; });
  };
  const navigate = useNavigate();
  const location = useLocation();
  const isMainPage = location.pathname === '/';

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

  const { containers = [], dockerError } = data ?? {};

  const special = containers.filter((c) => c.containerType === 'host' || c.containerType === 'local' || c.containerType === 'bridge');
  const running = containers.filter((c) => c.status === 'running' && !special.includes(c));
  const stopped = containers.filter((c) => c.status !== 'running' && !special.includes(c));

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
      <div className="w-72 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
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

        <div className="flex-1 overflow-y-auto py-2">
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
          {special.map((container) => (
            <ContainerNode
              key={container.id}
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
              sectionCollapsed={sectionsCollapsed.special}
              onToggleSection={() => setSectionsCollapsed((s) => ({ ...s, special: !s.special }))}
            />
          ))}
          {special.length > 0 && (running.length > 0 || stopped.length > 0) && (
            <div className="border-t border-gray-800 my-2" />
          )}
          {running.map((container) => (
            <ContainerNode
              key={container.id}
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
            />
          ))}
          {stopped.length > 0 && running.length > 0 && (
            <div className="border-t border-gray-800 my-2" />
          )}
          {stopped.map((container) => (
            <ContainerNode
              key={container.id}
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
            />
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
    </>
  );
}
