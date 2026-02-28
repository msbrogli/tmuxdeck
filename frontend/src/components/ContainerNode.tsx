import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Monitor,
  TerminalSquare,
  Radio,
  MoreVertical,
  Plus,
  Play,
  Square,
  Trash2,
  Pencil,
} from 'lucide-react';
import type { Container, SessionTarget, Selection } from '../types';
import { isFoldedContainerSelection } from '../types';
import { DockerIcon } from './icons/DockerIcon';
import { api } from '../api/client';
import { SessionItem } from './SessionItem';
import { ConfirmDialog } from './ConfirmDialog';
import { debugLog } from '../utils/debugLog';
import { getSessionOrder, saveSessionOrder } from '../utils/sessionOrder';
import { getContainerExpanded, saveContainerExpanded } from '../utils/sidebarState';

interface ContainerNodeProps {
  container: Container;
  selectedSession?: Selection | null;
  previewSession?: SessionTarget | null;
  onSelectSession?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewSession?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewEnd?: () => void;
  onRefresh: () => void;
  digitByTargetKey?: Record<string, string>;
  assignDigit?: (digit: string, target: SessionTarget) => void;
  isSessionExpanded?: (containerId: string, sessionId: string) => boolean;
  setSessionExpanded?: (containerId: string, sessionId: string, expanded: boolean) => void;
  isContainerExpanded?: (containerId: string) => boolean;
  setContainerExpanded?: (containerId: string, expanded: boolean) => void;
  sectionCollapsed?: boolean;
  onToggleSection?: () => void;
}

export function ContainerNode({
  container,
  selectedSession,
  previewSession,
  onSelectSession,
  onPreviewSession,
  onPreviewEnd,
  onRefresh,
  digitByTargetKey,
  assignDigit,
  isSessionExpanded: isSessionExpandedProp,
  setSessionExpanded: setSessionExpandedProp,
  isContainerExpanded: isContainerExpandedProp,
  setContainerExpanded: setContainerExpandedProp,
  sectionCollapsed,
  onToggleSection,
}: ContainerNodeProps) {
  const ctype = container.containerType ?? 'docker';
  const isHost = ctype === 'host';
  const isLocal = ctype === 'local';
  const isBridge = ctype === 'bridge';
  const isSpecial = isHost || isLocal || isBridge;
  const isRunning = container.status === 'running';
  const [localExpanded, setLocalExpandedRaw] = useState(() => {
    const saved = getContainerExpanded(container.id);
    return saved !== null ? saved : (isRunning || isSpecial);
  });
  const setLocalExpanded = (v: boolean) => { setLocalExpandedRaw(v); saveContainerExpanded(container.id, v); };
  const expanded = isContainerExpandedProp ? isContainerExpandedProp(container.id) : localExpanded;
  const setExpanded = setContainerExpandedProp
    ? (v: boolean) => setContainerExpandedProp(container.id, v)
    : setLocalExpanded;
  const isHighlightedFoldedContainer = selectedSession && isFoldedContainerSelection(selectedSession) && selectedSession.containerId === container.id;
  const [showMenu, setShowMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(container.displayName);
  const [newSessionName, setNewSessionName] = useState('');
  const [addingSession, setAddingSession] = useState(false);
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => getSessionOrder(container.id));
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const newSessionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && renameRef.current) renameRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (addingSession && newSessionRef.current) newSessionRef.current.focus();
  }, [addingSession]);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const orderedSessions = useMemo(() => {
    if (sessionOrder.length === 0) return container.sessions;
    const orderMap = new Map(sessionOrder.map((id, idx) => [id, idx]));
    return [...container.sessions].sort((a, b) => {
      const ia = orderMap.get(a.id) ?? Infinity;
      const ib = orderMap.get(b.id) ?? Infinity;
      if (ia === Infinity && ib === Infinity) return 0;
      return ia - ib;
    });
  }, [container.sessions, sessionOrder]);

  const handleReorderSession = useCallback((fromId: string, toId: string) => {
    const currentIds = orderedSessions.map((s) => s.id);
    const fromIdx = currentIds.indexOf(fromId);
    const toIdx = currentIds.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const newOrder = [...currentIds];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, fromId);
    setSessionOrder(newOrder);
    saveSessionOrder(container.id, newOrder);
  }, [orderedSessions, container.id]);

  const handleRename = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== container.displayName) {
      await api.renameContainer(container.id, trimmed);
      onRefresh();
    }
    setRenaming(false);
  };

  const handleAddSession = async () => {
    const name = newSessionName.trim();
    if (name) {
      debugLog.info('session', `Creating session '${name}'`, `container=${container.id}`);
      try {
        await api.createSession(container.id, { name });
        debugLog.info('session', `Session created: ${name}`, `container=${container.id}`);
      } catch (e) {
        debugLog.error('session', `Failed to create session '${name}': ${e}`, `container=${container.id}`);
      }
      onRefresh();
    }
    setAddingSession(false);
    setNewSessionName('');
  };

  const handleAction = async (action: string) => {
    setShowMenu(false);
    switch (action) {
      case 'start':
        await api.startContainer(container.id);
        break;
      case 'stop':
        await api.stopContainer(container.id);
        break;
      case 'remove':
        setConfirmingRemove(true);
        return;
      case 'rename':
        setRenameValue(container.displayName);
        setRenaming(true);
        return;
    }
    onRefresh();
  };

  const handleConfirmRemove = async () => {
    setConfirmingRemove(false);
    await api.removeContainer(container.id);
    onRefresh();
  };

  return (
    <div className={!isRunning && !isSpecial ? 'opacity-50' : ''}>
      {confirmingRemove && (
        <ConfirmDialog
          title="Remove Container"
          message="This will permanently remove the container and all its data. Type the container name to confirm."
          confirmLabel="Remove Container"
          requiredInput={container.displayName}
          inputPlaceholder="container name"
          onConfirm={handleConfirmRemove}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}

      <div className={`flex items-center group px-2 py-0.5 ${isHighlightedFoldedContainer ? 'bg-blue-900/40 rounded' : ''}`}>
        {isHost ? (
          <span className="p-0.5 shrink-0 text-blue-400 cursor-pointer" onClick={() => onToggleSection?.()}>
            <Monitor size={14} />
          </span>
        ) : isLocal ? (
          <span className="p-0.5 shrink-0 text-green-400 cursor-pointer" onClick={() => onToggleSection?.()}>
            <TerminalSquare size={14} />
          </span>
        ) : isBridge ? (
          <span className="p-0.5 shrink-0 text-purple-400 cursor-pointer" onClick={() => onToggleSection?.()}>
            <Radio size={14} />
          </span>
        ) : (
          <button
            onClick={() => isRunning && setExpanded(!expanded)}
            className="p-0.5 rounded hover:bg-gray-800 text-blue-300 shrink-0"
            disabled={!isRunning}
          >
            <DockerIcon size={14} />
          </button>
        )}

        {renaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="flex-1 bg-gray-800 text-sm text-gray-200 px-1.5 py-0.5 rounded border border-gray-600 outline-none focus:border-blue-500 min-w-0"
          />
        ) : (
          <span
            className={`flex-1 text-sm text-gray-300 truncate px-1 select-none ${
              (isSpecial && onToggleSection) || (!isSpecial && isRunning) ? 'cursor-pointer hover:text-gray-100' : 'cursor-default'
            }`}
            onClick={() => {
              if (isSpecial && onToggleSection) onToggleSection();
              else if (!isSpecial && isRunning) setExpanded(!expanded);
            }}
            onDoubleClick={() => {
              if (!isSpecial) {
                setRenameValue(container.displayName);
                setRenaming(true);
              }
            }}
          >
            {container.displayName}
          </span>
        )}

        {isHost ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-blue-900/50 text-blue-400">
            host
          </span>
        ) : isLocal ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-green-900/50 text-green-400">
            local
          </span>
        ) : isBridge ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-purple-900/50 text-purple-400">
            bridge
          </span>
        ) : (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
              isRunning ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-500'
            }`}
          >
            {container.status}
          </span>
        )}

        {!isSpecial && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            >
              <MoreVertical size={14} />
            </button>

            {showMenu && (
              <div className="absolute right-0 top-full mt-1 w-40 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 py-1">
                {!isRunning && (
                  <MenuItem icon={<Play size={13} />} label="Start" onClick={() => handleAction('start')} />
                )}
                {isRunning && (
                  <MenuItem icon={<Square size={13} />} label="Stop" onClick={() => handleAction('stop')} />
                )}
                <MenuItem icon={<Pencil size={13} />} label="Rename" onClick={() => handleAction('rename')} />
                <div className="border-t border-gray-700 my-1" />
                <MenuItem
                  icon={<Trash2 size={13} />}
                  label="Remove"
                  onClick={() => handleAction('remove')}
                  danger
                />
              </div>
            )}
          </div>
        )}
      </div>

      {expanded && (isRunning || isSpecial) && !sectionCollapsed && (
        <div className="ml-5">
          {orderedSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              containerId={container.id}
              selectedSession={selectedSession}
              previewSession={previewSession}
              onSelectWindow={(windowIndex) => onSelectSession?.(container.id, session.name, windowIndex)}
              onHoverWindow={(windowIndex) => onPreviewSession?.(container.id, session.name, windowIndex)}
              onHoverEnd={() => onPreviewEnd?.()}
              onRefresh={onRefresh}
              digitByTargetKey={digitByTargetKey}
              assignDigit={assignDigit}
              onReorderSession={handleReorderSession}
              isSessionExpanded={isSessionExpandedProp}
              setSessionExpanded={setSessionExpandedProp}
            />
          ))}

          {addingSession ? (
            <div className="flex items-center px-2 py-0.5">
              <span className="text-gray-600 mr-1 text-xs">|-</span>
              <input
                ref={newSessionRef}
                value={newSessionName}
                onChange={(e) => setNewSessionName(e.target.value)}
                onBlur={handleAddSession}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddSession();
                  if (e.key === 'Escape') {
                    setAddingSession(false);
                    setNewSessionName('');
                  }
                }}
                placeholder="session name"
                className="flex-1 bg-gray-800 text-xs text-gray-200 px-1.5 py-0.5 rounded border border-gray-600 outline-none focus:border-blue-500 min-w-0"
              />
            </div>
          ) : (
            <button
              onClick={() => setAddingSession(true)}
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-gray-500 hover:text-gray-300 transition-colors w-full"
            >
              <Plus size={12} />
              New Session
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm transition-colors ${
        danger
          ? 'text-red-400 hover:bg-red-900/30'
          : 'text-gray-300 hover:bg-gray-700'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
