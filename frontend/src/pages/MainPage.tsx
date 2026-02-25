import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sidebar } from '../components/Sidebar';
import { TerminalPool } from '../components/TerminalPool';
import type { TerminalPoolHandle } from '../components/TerminalPool';
import { SessionSwitcher } from '../components/SessionSwitcher';
import { KeyboardHelp } from '../components/KeyboardHelp';
import { Monitor, Maximize2, Eye } from 'lucide-react';
import { useTerminalPool } from '../hooks/useTerminalPool';
import { useWindowShortcuts } from '../hooks/useWindowShortcuts';
import { api } from '../api/client';
import { logout } from '../api/httpClient';
import type { SessionTarget, Container, Settings } from '../types';
import { sortSessionsByOrder } from '../utils/sessionOrder';

function getInitialSession(): SessionTarget | null {
  try {
    const state = window.history.state?.usr as { selectSession?: SessionTarget } | null;
    if (state?.selectSession) {
      // Clear navigation state so it doesn't re-trigger
      window.history.replaceState({}, '');
      return state.selectSession;
    }
  } catch { /* ignore */ }
  return null;
}

export function MainPage() {
  const [selectedSession, setSelectedSession] = useState<SessionTarget | null>(getInitialSession);
  const [previewSession, setPreviewSession] = useState<SessionTarget | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const poolRef = useRef<TerminalPoolHandle>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const prevBellKeysRef = useRef<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { map: shortcutMap, assignDigit, digitByTargetKey } = useWindowShortcuts();
  const shortcutMapRef = useRef(shortcutMap);
  useEffect(() => { shortcutMapRef.current = shortcutMap; }, [shortcutMap]);

  // Read pool size from settings
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });
  const poolSize = (settings as Settings | undefined)?.terminalPoolSize ?? 8;

  const pool = useTerminalPool({ maxSize: poolSize, idleTimeoutMs: 60_000 });

  // Derive what to display
  const displayedSession = previewSession ?? selectedSession;
  const isPreview = previewSession !== null;

  // Derive activeKey — must match useTerminalPool's makeKey (container+session only)
  const activeKey = displayedSession
    ? `${displayedSession.containerId}-${displayedSession.sessionName}`
    : null;

  // Keep pool's activeKey ref in sync (for LRU eviction protection)
  pool.setActiveKey(activeKey);

  // Ensure the displayed session always has a pool entry.
  // This handles the case where a same-session sibling preview evicts
  // the committed entry, and then preview clears — we need to recreate it.
  // useLayoutEffect avoids a visible blank frame.
  const poolEnsure = pool.ensure;
  useLayoutEffect(() => {
    if (displayedSession) {
      poolEnsure(displayedSession);
    }
  }, [displayedSession, poolEnsure]);

  const clearPreview = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
    }
    clearTimeoutRef.current = setTimeout(() => {
      // selectedSession is already in pool — no ensure needed
      setPreviewSession(null);
      clearTimeoutRef.current = null;
    }, 100);
  }, []);

  const clearPreviewImmediate = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }
    setPreviewSession(null);
  }, []);

  const previewWindow = useCallback((containerId: string, sessionName: string, windowIndex: number) => {
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }

    if (
      selectedSession &&
      selectedSession.containerId === containerId &&
      selectedSession.sessionName === sessionName &&
      selectedSession.windowIndex === windowIndex
    ) {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
        previewTimeoutRef.current = null;
      }
      setPreviewSession(null);
      return;
    }

    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }

    previewTimeoutRef.current = setTimeout(() => {
      // Ensure entry exists BEFORE setting preview — batched in same React update
      pool.ensure({ containerId, sessionName, windowIndex });
      setPreviewSession({ containerId, sessionName, windowIndex });
      previewTimeoutRef.current = null;
    }, 300);
  }, [selectedSession, pool]);

  const selectSession = useCallback((containerId: string, sessionName: string, windowIndex: number) => {
    clearPreviewImmediate();
    // Ensure entry exists BEFORE setting selection — batched in same React update
    pool.ensure({ containerId, sessionName, windowIndex });
    setSelectedSession({ containerId, sessionName, windowIndex });
    const key = `${containerId}:${sessionName}:${windowIndex}`;
    setRecentIds((prev) => [
      key,
      ...prev.filter((id) => id !== key),
    ].slice(0, 20));
    requestAnimationFrame(() => poolRef.current?.focusActive());
  }, [clearPreviewImmediate, pool]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    };
  }, []);

  // Browser notifications for bell flags
  useEffect(() => {
    const containers: Container[] | undefined = queryClient.getQueryData(['containers']);
    if (!containers) return;

    const currentBellKeys = new Set<string>();
    for (const c of containers) {
      for (const s of c.sessions) {
        for (const w of s.windows) {
          if (w.bell) {
            const key = `${c.id}:${s.name}:${w.index}`;
            currentBellKeys.add(key);

            if (!prevBellKeysRef.current.has(key)) {
              const isDisplayed =
                displayedSession &&
                displayedSession.containerId === c.id &&
                displayedSession.sessionName === s.name &&
                displayedSession.windowIndex === w.index;

              if (!isDisplayed && Notification.permission === 'granted') {
                new Notification(`Bell: ${s.name} window ${w.index}`, {
                  body: `Window "${w.name}" in ${c.displayName} needs attention`,
                  tag: key,
                });
              }
            }
          }
        }
      }
    }
    prevBellKeysRef.current = currentBellKeys;
  });

  // Request notification permission on first user interaction
  useEffect(() => {
    const requestPermission = () => {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      window.removeEventListener('click', requestPermission);
    };
    window.addEventListener('click', requestPermission);
    return () => window.removeEventListener('click', requestPermission);
  }, []);

  const escTimestampRef = useRef<number>(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
      const digitMatch = e.code.match(/^Digit(\d)$/);
      if (digitMatch && (e.ctrlKey || e.metaKey)) {
        const digit = digitMatch[1];
        e.preventDefault();
        if (e.altKey) {
          if (selectedSession) assignDigit(digit, selectedSession);
        } else {
          const target = shortcutMapRef.current[digit];
          if (target) selectSession(target.containerId, target.sessionName, target.windowIndex);
        }
      }
      // Alt+1-9: jump to Nth window in current session
      if (digitMatch && e.altKey && !e.ctrlKey && !e.metaKey) {
        const digit = parseInt(digitMatch[1], 10);
        if (digit >= 1 && digit <= 9 && selectedSession) {
          const containers: Container[] | undefined = queryClient.getQueryData(['containers']);
          if (containers) {
            const container = containers.find((c) => c.id === selectedSession.containerId);
            const session = container?.sessions.find((s) => s.name === selectedSession.sessionName);
            if (session && session.windows.length >= digit) {
              e.preventDefault();
              const win = session.windows[digit - 1];
              selectSession(selectedSession.containerId, selectedSession.sessionName, win.index);
            }
          }
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const containers: Container[] | undefined = queryClient.getQueryData(['containers']);
        if (containers && selectedSession) {
          e.preventDefault();
          const allWindows: SessionTarget[] = [];
          for (const c of containers) {
            if (c.status !== 'running' && !c.isHost && !c.isLocal) continue;
            const ordered = sortSessionsByOrder(c.sessions, c.id);
            for (const s of ordered) {
              for (const w of s.windows) {
                allWindows.push({ containerId: c.id, sessionName: s.name, windowIndex: w.index });
              }
            }
          }
          if (allWindows.length > 0) {
            const curIdx = allWindows.findIndex(
              (t) => t.containerId === selectedSession.containerId &&
                     t.sessionName === selectedSession.sessionName &&
                     t.windowIndex === selectedSession.windowIndex
            );
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            const nextIdx = curIdx === -1 ? 0 : (curIdx + delta + allWindows.length) % allWindows.length;
            const next = allWindows[nextIdx];
            selectSession(next.containerId, next.sessionName, next.windowIndex);
          }
        }
      }
      if (e.key === 'Escape' && !switcherOpen && !helpOpen) {
        const now = Date.now();
        if (now - escTimestampRef.current < 500) {
          if (selectedSession === null && previewSession === null) {
            // Already deselected — logout to PIN screen
            logout().then(() => {
              queryClient.invalidateQueries({ queryKey: ['auth'] });
            });
          } else {
            setSelectedSession(null);
            clearPreviewImmediate();
          }
          escTimestampRef.current = 0;
        } else {
          escTimestampRef.current = now;
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [switcherOpen, helpOpen, clearPreviewImmediate, selectedSession, previewSession, assignDigit, selectSession, queryClient]);

  return (
    <div className="flex h-full w-full">
      <Sidebar
        selectedSession={selectedSession}
        previewSession={previewSession}
        onSelectSession={selectSession}
        onPreviewSession={previewWindow}
        onPreviewEnd={clearPreview}
        digitByTargetKey={digitByTargetKey}
        assignDigit={assignDigit}
      />
      <div className="flex-1 bg-[#0a0a0a] flex flex-col min-w-0">
        <div className="flex-1 min-h-0 relative">
          <TerminalPool ref={poolRef} entries={pool.entries} activeKey={activeKey} />
          {!displayedSession && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="text-center text-gray-600">
                <Monitor size={48} className="mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">Select a session to connect</p>
                <p className="text-sm mt-1">
                  <kbd className="bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded border border-gray-700 text-xs">Ctrl+K</kbd>
                  {' '}to quick-switch sessions
                </p>
              </div>
            </div>
          )}
          {isPreview && (
            <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded bg-blue-900/70 text-blue-300 text-xs z-30 pointer-events-none">
              <Eye size={12} />
              Preview
            </div>
          )}
          {displayedSession && (
            <button
              onClick={() => {
                poolRef.current?.refitActive();
                poolRef.current?.focusActive();
              }}
              className="absolute top-2 right-2 p-1.5 rounded bg-gray-800/80 text-gray-500 hover:text-gray-200 hover:bg-gray-700/90 transition-colors opacity-0 hover:opacity-100 focus:opacity-100 z-30"
              title="Fit terminal to window"
            >
              <Maximize2 size={14} />
            </button>
          )}
          {isPreview && (
            <div className="absolute inset-0 z-20 ring-1 ring-blue-500/30 rounded pointer-events-none" />
          )}
        </div>
      </div>

      {switcherOpen && (
        <SessionSwitcher
          onClose={() => { clearPreviewImmediate(); setSwitcherOpen(false); }}
          onSelect={selectSession}
          onPreview={previewWindow}
          onPreviewEnd={clearPreview}
          recentIds={recentIds}
          digitByTargetKey={digitByTargetKey}
        />
      )}

      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
