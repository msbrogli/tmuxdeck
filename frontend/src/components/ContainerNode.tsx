import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Monitor,
  TerminalSquare,
  MoreVertical,
  Plus,
  Play,
  Square,
  Trash2,
  Pencil,
} from 'lucide-react';
import type { Container, SessionTarget } from '../types';
import { api } from '../api/client';
import { SessionItem } from './SessionItem';
import { ConfirmDialog } from './ConfirmDialog';
import { getSessionOrder, saveSessionOrder } from '../utils/sessionOrder';

interface ContainerNodeProps {
  container: Container;
  selectedSession?: SessionTarget | null;
  previewSession?: SessionTarget | null;
  onSelectSession?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewSession?: (containerId: string, sessionName: string, windowIndex: number) => void;
  onPreviewEnd?: () => void;
  onRefresh: () => void;
  digitByTargetKey?: Record<string, string>;
  assignDigit?: (digit: string, target: SessionTarget) => void;
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
  sectionCollapsed,
  onToggleSection,
}: ContainerNodeProps) {
  const isHost = container.isHost === true;
  const isLocal = container.isLocal === true;
  const isSpecial = isHost || isLocal;
  const isRunning = container.status === 'running';
  const [expanded, setExpanded] = useState(isRunning || isSpecial);
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
      await api.createSession(container.id, { name });
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

      <div className="flex items-center group px-2 py-0.5">
        {isHost ? (
          <span className="p-0.5 shrink-0 text-blue-400 cursor-pointer" onClick={() => onToggleSection?.()}>
            <Monitor size={14} />
          </span>
        ) : isLocal ? (
          <span className="p-0.5 shrink-0 text-green-400 cursor-pointer" onClick={() => onToggleSection?.()}>
            <TerminalSquare size={14} />
          </span>
        ) : (
          <button
            onClick={() => isRunning && setExpanded(!expanded)}
            className="p-0.5 rounded hover:bg-gray-800 text-gray-500 shrink-0"
            disabled={!isRunning}
          >
            {expanded && isRunning ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
              isSpecial && onToggleSection ? 'cursor-pointer hover:text-gray-100' : 'cursor-default'
            }`}
            onClick={() => {
              if (isSpecial && onToggleSection) onToggleSection();
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
