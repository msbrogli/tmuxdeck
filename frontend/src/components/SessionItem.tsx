import { useState, useRef, useEffect } from 'react';
import { Terminal as TerminalIcon, ChevronRight, ChevronDown, X, AppWindow, Bell, Circle, Plus } from 'lucide-react';
import type { TmuxSession, SessionTarget } from '../types';
import { api } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';

interface WindowDragData {
  containerId: string;
  sessionId: string;
  sessionName: string;
  windowIndex: number;
}

interface SessionDragData {
  containerId: string;
  sessionId: string;
  sessionName: string;
}

const DRAG_MIME = 'application/x-tmux-window';
const SESSION_DRAG_MIME = 'application/x-tmux-session';

// Module-level state to track the current drag source (readable during dragOver)
let currentDragSource: { containerId: string; sessionId: string; type: 'window' | 'session' } | null = null;

interface SessionItemProps {
  session: TmuxSession;
  containerId: string;
  selectedSession?: SessionTarget | null;
  previewSession?: SessionTarget | null;
  onSelectWindow: (windowIndex: number) => void;
  onHoverWindow?: (windowIndex: number) => void;
  onHoverEnd?: () => void;
  onRefresh: () => void;
  digitByTargetKey?: Record<string, string>;
  assignDigit?: (digit: string, target: SessionTarget) => void;
  onReorderSession?: (fromSessionId: string, toSessionId: string) => void;
}

export function SessionItem({
  session,
  containerId,
  selectedSession,
  previewSession,
  onSelectWindow,
  onHoverWindow,
  onHoverEnd,
  onRefresh,
  digitByTargetKey,
  assignDigit,
  onReorderSession,
}: SessionItemProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [sessionHeaderDragOver, setSessionHeaderDragOver] = useState(false);
  const [isDraggingSession, setIsDraggingSession] = useState(false);
  const [addingWindow, setAddingWindow] = useState(false);
  const [newWindowName, setNewWindowName] = useState('');
  const newWindowRef = useRef<HTMLInputElement>(null);
  const [confirmingKill, setConfirmingKill] = useState(false);

  useEffect(() => {
    if (renaming && inputRef.current) inputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (addingWindow && newWindowRef.current) newWindowRef.current.focus();
  }, [addingWindow]);

  const handleRename = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.name) {
      await api.renameSession(containerId, session.id, trimmed);
      onRefresh();
    }
    setRenaming(false);
  };

  const handleAddWindow = async () => {
    const name = newWindowName.trim() || undefined;
    await api.createWindow(containerId, session.id, { name });
    onRefresh();
    setAddingWindow(false);
    setNewWindowName('');
  };

  const handleKill = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmingKill(true);
  };

  const handleConfirmKill = async () => {
    setConfirmingKill(false);
    await api.killSession(containerId, session.id);
    onRefresh();
  };

  // --- Window drag handlers ---

  const handleWindowDragStart = (e: React.DragEvent, windowIndex: number) => {
    const data: WindowDragData = {
      containerId,
      sessionId: session.id,
      sessionName: session.name,
      windowIndex,
    };
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(windowIndex);
    currentDragSource = { containerId, sessionId: session.id, type: 'window' };
  };

  const handleWindowDragEnd = () => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
    currentDragSource = null;
  };

  const handleWindowDragOver = (e: React.DragEvent, windowIndex: number) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetIndex(windowIndex);
  };

  const handleWindowDragLeave = () => {
    setDropTargetIndex(null);
  };

  const handleWindowDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    setDropTargetIndex(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    const data: WindowDragData = JSON.parse(raw);

    // Same session → swap
    if (data.containerId === containerId && data.sessionId === session.id) {
      if (data.windowIndex !== targetIndex) {
        await api.swapWindows(containerId, session.id, data.windowIndex, targetIndex);
        // Keep the selected window selected at its new position
        if (hasAnyWindowSelected) {
          if (selectedSession?.windowIndex === data.windowIndex) {
            onSelectWindow(targetIndex);
          } else if (selectedSession?.windowIndex === targetIndex) {
            onSelectWindow(data.windowIndex);
          }
        }
        // Swap quick-switch shortcuts to follow their windows
        if (assignDigit && digitByTargetKey) {
          const key1 = `${containerId}:${session.name}:${data.windowIndex}`;
          const key2 = `${containerId}:${session.name}:${targetIndex}`;
          const digit1 = digitByTargetKey[key1];
          const digit2 = digitByTargetKey[key2];
          if (digit1) {
            assignDigit(digit1, { containerId, sessionName: session.name, windowIndex: targetIndex });
          }
          if (digit2) {
            assignDigit(digit2, { containerId, sessionName: session.name, windowIndex: data.windowIndex });
          }
        }
        onRefresh();
      }
    } else if (data.containerId === containerId) {
      // Different session, same container → move
      await api.moveWindow(containerId, data.sessionId, data.windowIndex, session.id);
      onRefresh();
    }
  };

  // --- Session drag handlers ---

  const handleSessionDragStart = (e: React.DragEvent) => {
    if (renaming) {
      e.preventDefault();
      return;
    }
    const data: SessionDragData = {
      containerId,
      sessionId: session.id,
      sessionName: session.name,
    };
    e.dataTransfer.setData(SESSION_DRAG_MIME, JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'move';
    setIsDraggingSession(true);
    currentDragSource = { containerId, sessionId: session.id, type: 'session' };
  };

  const handleSessionDragEnd = () => {
    setIsDraggingSession(false);
    currentDragSource = null;
  };

  // --- Session header as drop target (for window moves AND session reorder) ---

  const handleSessionHeaderDragOver = (e: React.DragEvent) => {
    // Session reorder: accept session drags from same container, different session
    if (e.dataTransfer.types.includes(SESSION_DRAG_MIME)) {
      if (
        currentDragSource?.type === 'session' &&
        currentDragSource.containerId === containerId &&
        currentDragSource.sessionId !== session.id
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setSessionHeaderDragOver(true);
      }
      return;
    }
    // Window move: accept window drags from different session, same container
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      if (currentDragSource?.containerId === containerId && currentDragSource?.sessionId === session.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setSessionHeaderDragOver(true);
    }
  };

  const handleSessionHeaderDragLeave = () => {
    setSessionHeaderDragOver(false);
  };

  const handleSessionHeaderDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setSessionHeaderDragOver(false);

    // Session reorder
    const sessionRaw = e.dataTransfer.getData(SESSION_DRAG_MIME);
    if (sessionRaw) {
      const data: SessionDragData = JSON.parse(sessionRaw);
      if (data.containerId === containerId && data.sessionId !== session.id) {
        onReorderSession?.(data.sessionId, session.id);
      }
      return;
    }

    // Window move
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    const data: WindowDragData = JSON.parse(raw);
    if (data.containerId === containerId && data.sessionId !== session.id) {
      await api.moveWindow(containerId, data.sessionId, data.windowIndex, session.id);
      onRefresh();
    }
  };

  const hasAnyWindowSelected =
    selectedSession?.containerId === containerId &&
    selectedSession?.sessionName === session.name;

  const hasAnyWindowPreviewed =
    previewSession?.containerId === containerId &&
    previewSession?.sessionName === session.name;

  return (
    <div className={isDraggingSession ? 'opacity-50' : ''}>
      {confirmingKill && (
        <ConfirmDialog
          title="Kill Session"
          message={`This will permanently kill the tmux session and all its windows. Type the session name to confirm.`}
          confirmLabel="Kill Session"
          requiredInput={session.name}
          inputPlaceholder="session name"
          onConfirm={handleConfirmKill}
          onCancel={() => setConfirmingKill(false)}
        />
      )}

      {/* Session row (draggable + drop target) */}
      <div
        draggable={!renaming}
        onDragStart={handleSessionDragStart}
        onDragEnd={handleSessionDragEnd}
        className={`flex items-center group px-2 py-0.5 cursor-pointer rounded-sm transition-colors text-gray-400 hover:bg-gray-800 hover:text-gray-200 ${
          sessionHeaderDragOver ? 'bg-blue-900/30 ring-1 ring-blue-500/50' : ''
        }`}
        onClick={() => setExpanded(!expanded)}
        onDragOver={handleSessionHeaderDragOver}
        onDragLeave={handleSessionHeaderDragLeave}
        onDrop={handleSessionHeaderDrop}
      >
        {expanded ? <ChevronDown size={12} className="shrink-0 mr-0.5" /> : <ChevronRight size={12} className="shrink-0 mr-0.5" />}
        <TerminalIcon size={12} className="shrink-0 mr-1.5" />

        {renaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRename}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="flex-1 bg-gray-800 text-xs text-gray-200 px-1.5 py-0.5 rounded border border-gray-600 outline-none focus:border-blue-500 min-w-0"
          />
        ) : (
          <span
            className="flex-1 text-xs truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenameValue(session.name);
              setRenaming(true);
            }}
          >
            {session.name}
          </span>
        )}

        <button
          onClick={handleKill}
          className="p-0.5 rounded hover:bg-gray-700 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          title="Kill session"
        >
          <X size={12} />
        </button>
      </div>

      {/* Window rows */}
      {expanded && (
        <div className="ml-4">
          {session.windows.map((win, position) => {
            const isSelected =
              hasAnyWindowSelected &&
              selectedSession?.windowIndex === win.index;

            const isPreviewed =
              hasAnyWindowPreviewed &&
              previewSession?.windowIndex === win.index;

            const isDragged = draggedIndex === win.index;
            const isDropTarget = dropTargetIndex === win.index;

            return (
              <div
                key={win.index}
                draggable
                onDragStart={(e) => handleWindowDragStart(e, win.index)}
                onDragEnd={handleWindowDragEnd}
                onDragOver={(e) => handleWindowDragOver(e, win.index)}
                onDragLeave={handleWindowDragLeave}
                onDrop={(e) => handleWindowDrop(e, win.index)}
                className={`flex items-center group px-2 py-0.5 cursor-pointer rounded-sm transition-colors ${
                  isDragged ? 'opacity-50' : ''
                } ${
                  isDropTarget ? 'border-t-2 border-blue-500' : 'border-t-2 border-transparent'
                } ${
                  isSelected
                    ? 'bg-blue-900/40 text-blue-300'
                    : isPreviewed
                      ? 'bg-blue-900/20 text-blue-400/70'
                      : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
                }`}
                onClick={() => onSelectWindow(win.index)}
                onMouseEnter={() => onHoverWindow?.(win.index)}
                onMouseLeave={() => onHoverEnd?.()}
              >
                <AppWindow size={11} className="shrink-0 mr-1.5" />
                <span className="text-xs truncate flex-1">
                  {position + 1}: {win.name}
                </span>
                {win.bell && (
                  <span className="shrink-0 mr-1 text-orange-400" title="Bell">
                    <Bell size={10} />
                  </span>
                )}
                {win.activity && (
                  <span className="shrink-0 mr-1 text-blue-400" title="Activity">
                    <Circle size={8} className="fill-blue-400" />
                  </span>
                )}
                {win.active && (
                  <span className="text-[9px] text-green-500 shrink-0 mr-1">*</span>
                )}
                {isPreviewed && (
                  <span className="text-[10px] text-blue-400/60 shrink-0">preview</span>
                )}
                {isSelected && !isPreviewed && (
                  <span className="text-[10px] text-blue-400 shrink-0">active</span>
                )}
                {(() => {
                  const windowKey = `${containerId}:${session.name}:${win.index}`;
                  const assignedDigit = digitByTargetKey?.[windowKey];
                  return assignedDigit != null ? (
                    <span className="shrink-0 ml-1 text-[10px] font-mono font-medium bg-gray-700 text-yellow-400 rounded px-1 py-px leading-none"
                          title={`Ctrl+${assignedDigit}`}>
                      {assignedDigit}
                    </span>
                  ) : null;
                })()}
              </div>
            );
          })}

          {addingWindow ? (
            <div className="flex items-center px-2 py-0.5">
              <Plus size={11} className="shrink-0 mr-1.5 text-gray-600" />
              <input
                ref={newWindowRef}
                value={newWindowName}
                onChange={(e) => setNewWindowName(e.target.value)}
                onBlur={handleAddWindow}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddWindow();
                  if (e.key === 'Escape') {
                    setAddingWindow(false);
                    setNewWindowName('');
                  }
                }}
                placeholder="window name (optional)"
                className="flex-1 bg-gray-800 text-xs text-gray-200 px-1.5 py-0.5 rounded border border-gray-600 outline-none focus:border-blue-500 min-w-0"
              />
            </div>
          ) : (
            <button
              onClick={() => setAddingWindow(true)}
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-gray-600 hover:text-gray-300 transition-colors w-full"
            >
              <Plus size={11} />
              Window
            </button>
          )}
        </div>
      )}
    </div>
  );
}
