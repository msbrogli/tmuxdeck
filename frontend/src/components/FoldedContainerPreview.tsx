import { useState, useEffect, useCallback } from 'react';
import type { TmuxWindow, Container, FoldedContainerTarget, TmuxSession, ContainerListResponse } from '../types';
import { useQueryClient } from '@tanstack/react-query';
import { sortSessionsByOrder } from '../utils/sessionOrder';

type PaneState = 'idle' | 'busy' | 'waiting' | 'attention';

const IDLE_COMMANDS = [
  'bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'login', '-bash', '-zsh', '-sh', '-fish',
  'vim', 'nvim', 'vi', 'nano', 'emacs', 'micro', 'helix', 'hx', 'joe', 'ne', 'kakoune', 'kak',
  'less', 'more', 'most', 'bat', 'man',
  'htop', 'btop', 'top', 'atop', 'glances',
  'tmux', 'screen',
  'mc', 'tig', 'lazygit', 'lazydocker',
  'python', 'python3', 'ipython', 'node', 'irb', 'ghci', 'lua',
];

function getPaneState(win: TmuxWindow): PaneState {
  if (win.paneStatus === 'attention') return 'attention';
  if (win.paneStatus === 'waiting') return 'waiting';
  if (win.paneStatus === 'running') return 'busy';
  if (win.paneStatus === 'idle') return 'idle';
  if (!win.command || IDLE_COMMANDS.includes(win.command)) return 'idle';
  return 'busy';
}

function getSessionAggregateState(session: TmuxSession): PaneState {
  let hasAttention = false;
  let hasWaiting = false;
  let hasBusy = false;
  for (const w of session.windows) {
    const s = getPaneState(w);
    if (s === 'attention') hasAttention = true;
    if (s === 'waiting') hasWaiting = true;
    if (s === 'busy') hasBusy = true;
  }
  if (hasAttention) return 'attention';
  if (hasWaiting) return 'waiting';
  if (hasBusy) return 'busy';
  return 'idle';
}

const stateColors: Record<PaneState, string> = {
  idle: 'text-gray-500',
  busy: 'text-amber-400',
  waiting: 'text-green-400',
  attention: 'text-blue-400',
};

const stateLabels: Record<PaneState, string> = {
  idle: 'idle',
  busy: 'running',
  waiting: 'waiting',
  attention: 'attention',
};

interface FoldedContainerPreviewProps {
  selection: FoldedContainerTarget;
  onUnfoldAndSelect: (sessionIndex: number) => void;
}

export function FoldedContainerPreview({ selection, onUnfoldAndSelect }: FoldedContainerPreviewProps) {
  const queryClient = useQueryClient();
  const [focusedRow, setFocusedRow] = useState(0);

  const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
  const container = containers?.find((c) => c.id === selection.containerId);
  const sessions = container ? sortSessionsByOrder(container.sessions, container.id) : [];

  const handleSelect = useCallback((idx: number) => {
    if (sessions[idx]) {
      onUnfoldAndSelect(idx);
    }
  }, [sessions, onUnfoldAndSelect]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setFocusedRow((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setFocusedRow((prev) => Math.min(sessions.length - 1, prev + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSelect(focusedRow);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focusedRow, sessions.length, handleSelect]);

  // Clamp focused row if session list shrinks
  useEffect(() => {
    if (focusedRow >= sessions.length && sessions.length > 0) {
      setFocusedRow(sessions.length - 1);
    }
  }, [focusedRow, sessions.length]);

  if (!container) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0a] text-gray-600 text-sm">
        Container not found
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full bg-[#0a0a0a]">
      <div className="font-mono text-sm max-w-lg w-full px-8">
        <div className="text-gray-500 mb-4">
          <span className="text-gray-400">{container.displayName}</span>
          <span className="text-gray-600"> ({sessions.length} session{sessions.length !== 1 ? 's' : ''})</span>
        </div>

        <div className="space-y-0.5">
          {sessions.map((session, i) => {
            const state = getSessionAggregateState(session);
            const isFocused = i === focusedRow;
            return (
              <div
                key={session.id}
                className={`flex items-center gap-3 px-3 py-1 rounded cursor-pointer transition-colors ${
                  isFocused ? 'bg-blue-900/40 text-blue-200' : 'text-gray-400 hover:bg-gray-800/50'
                }`}
                onClick={() => handleSelect(i)}
                onMouseEnter={() => setFocusedRow(i)}
              >
                <span className={`flex-1 truncate ${isFocused ? 'text-blue-200' : 'text-gray-300'}`}>
                  {session.name}
                </span>
                <span className={`text-xs shrink-0 ${isFocused ? 'text-blue-300/60' : 'text-gray-600'}`}>
                  {session.windows.length} win{session.windows.length !== 1 ? 's' : ''}
                </span>
                <span className={`text-xs shrink-0 ${stateColors[state]}`}>
                  {state === 'busy' || state === 'attention' ? '◉' : '●'} {stateLabels[state]}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 text-[11px] text-gray-700">
          ↑↓ navigate · Enter to select · Ctrl+→ unfold
        </div>
      </div>
    </div>
  );
}
