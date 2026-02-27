import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sidebar } from '../components/Sidebar';
import { TerminalPool } from '../components/TerminalPool';
import type { TerminalPoolHandle } from '../components/TerminalPool';
import { SessionSwitcher } from '../components/SessionSwitcher';
import { KeyboardHelp } from '../components/KeyboardHelp';
import { FileViewer } from '../components/FileViewer';
import { FoldedSessionPreview } from '../components/FoldedSessionPreview';
import { Monitor, Maximize2, Eye } from 'lucide-react';
import { useToast } from '../components/ToastContainer';
import { useTerminalPool } from '../hooks/useTerminalPool';
import { useWindowShortcuts } from '../hooks/useWindowShortcuts';
import { useSessionExpandedState } from '../hooks/useSessionExpandedState';
import { api } from '../api/client';
import { logout } from '../api/httpClient';
import type { SessionTarget, Selection, FoldedSessionTarget, Container, ContainerListResponse, Settings, ClaudeNotification } from '../types';
import { isWindowSelection, isFoldedSelection } from '../types';
import { sortSessionsByOrder } from '../utils/sessionOrder';
import { getContainerExpanded } from '../utils/sidebarState';
import { DEFAULT_HOTKEYS, matchesBinding, matchesDoublePressKey } from '../utils/hotkeys';

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
  const [selectedSession, setSelectedSession] = useState<Selection | null>(getInitialSession);
  const [previewSession, setPreviewSession] = useState<SessionTarget | null>(null);
  const { isSessionExpanded, setSessionExpanded } = useSessionExpandedState();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [viewingFile, setViewingFile] = useState<{ containerId: string; path: string } | null>(null);
  const poolRef = useRef<TerminalPoolHandle>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const prevBellKeysRef = useRef<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const { addToast } = useToast();

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
  const isFolded = displayedSession !== null && isFoldedSelection(displayedSession);

  // Derive activeKey — must match useTerminalPool's makeKey (container+session only)
  // When folded, hide all terminals
  const activeKey = displayedSession && !isFolded
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
    if (displayedSession && !isFoldedSelection(displayedSession)) {
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
      isWindowSelection(selectedSession) &&
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

  const selectFoldedSession = useCallback((target: FoldedSessionTarget) => {
    clearPreviewImmediate();
    setSelectedSession(target);
  }, [clearPreviewImmediate]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    };
  }, []);

  // Browser notifications for bell flags
  useEffect(() => {
    const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
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
                isWindowSelection(displayedSession) &&
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

  // SSE listener for Claude Code notifications
  useEffect(() => {
    const evtSource = new EventSource('/api/v1/notifications/stream');

    evtSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.event === 'notification' && parsed.data) {
          const notif: ClaudeNotification = parsed.data;
          const ch = notif.channels;
          const showWeb = !ch || ch.length === 0 || ch.includes('web');
          const showOs = !ch || ch.length === 0 || ch.includes('os');

          // Show in-app toast if web channel enabled
          if (showWeb) {
            addToast({
              title: notif.title || 'Claude Code',
              message: notif.message || 'Needs attention',
              onClick: notif.containerId && notif.tmuxSession != null
                ? () => selectSession(notif.containerId, notif.tmuxSession, notif.tmuxWindow ?? 0)
                : undefined,
            });
          }

          // Fire browser notification if os channel enabled and permission granted
          if (showOs && 'Notification' in window) {
            if (Notification.permission === 'granted') {
              const n = new window.Notification(notif.title || 'Claude Code', {
                body: notif.message || 'Needs attention',
                tag: `claude-${notif.id}`,
              });
              n.onclick = () => {
                window.focus();
                if (notif.containerId && notif.tmuxSession != null) {
                  selectSession(notif.containerId, notif.tmuxSession, notif.tmuxWindow ?? 0);
                }
              };
            } else if (Notification.permission === 'default') {
              addToast({
                title: 'Enable OS notifications?',
                message: 'Click here to allow browser notifications for TMuxDeck alerts.',
                onClick: () => { Notification.requestPermission(); },
              });
            }
          }
        }
      } catch { /* ignore parse errors */ }
    };

    return () => evtSource.close();
  }, [selectSession, addToast]);

  const escTimestampRef = useRef<number>(0);

  // Merge user hotkeys with defaults
  const hotkeys = { ...DEFAULT_HOTKEYS, ...(settings as Settings | undefined)?.hotkeys };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesBinding(e, hotkeys.quickSwitch)) {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
      if (matchesBinding(e, hotkeys.showHelp)) {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
      const digitMatch = e.code.match(/^Digit(\d)$/);
      if (digitMatch && (e.ctrlKey || e.metaKey)) {
        const digit = digitMatch[1];
        e.preventDefault();
        if (e.altKey) {
          // Ctrl+Alt+N: assign digit — only when a window is selected
          if (selectedSession && isWindowSelection(selectedSession)) assignDigit(digit, selectedSession);
        } else {
          const target = shortcutMapRef.current[digit];
          if (target) selectSession(target.containerId, target.sessionName, target.windowIndex);
        }
      }
      // Alt+1-9: jump to Nth window in current session — skip if folded
      if (digitMatch && e.altKey && !e.ctrlKey && !e.metaKey) {
        const digit = parseInt(digitMatch[1], 10);
        if (digit >= 1 && digit <= 9 && selectedSession && isWindowSelection(selectedSession)) {
          const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
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
      // Move window up/down: swap current window within session — skip if folded
      if (matchesBinding(e, hotkeys.moveWindowUp) || matchesBinding(e, hotkeys.moveWindowDown)) {
        if (selectedSession && isFoldedSelection(selectedSession)) return;
        const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
        if (containers && selectedSession && isWindowSelection(selectedSession)) {
          e.preventDefault();
          const container = containers.find((c) => c.id === selectedSession.containerId);
          const session = container?.sessions.find((s) => s.name === selectedSession.sessionName);
          if (session) {
            const sortedWindows = [...session.windows].sort((a, b) => a.index - b.index);
            const curPos = sortedWindows.findIndex((w) => w.index === selectedSession.windowIndex);
            if (curPos !== -1) {
              const targetPos = matchesBinding(e, hotkeys.moveWindowUp) ? curPos - 1 : curPos + 1;
              if (targetPos >= 0 && targetPos < sortedWindows.length) {
                const currentWindowIndex = sortedWindows[curPos].index;
                const targetWindowIndex = sortedWindows[targetPos].index;
                api.swapWindows(selectedSession.containerId, session.id, currentWindowIndex, targetWindowIndex);
                selectSession(selectedSession.containerId, selectedSession.sessionName, targetWindowIndex);
                // Swap digit shortcuts to follow their windows
                const key1 = `${selectedSession.containerId}:${selectedSession.sessionName}:${currentWindowIndex}`;
                const key2 = `${selectedSession.containerId}:${selectedSession.sessionName}:${targetWindowIndex}`;
                const d1 = digitByTargetKey[key1];
                const d2 = digitByTargetKey[key2];
                if (d1) assignDigit(d1, { containerId: selectedSession.containerId, sessionName: selectedSession.sessionName, windowIndex: targetWindowIndex });
                if (d2) assignDigit(d2, { containerId: selectedSession.containerId, sessionName: selectedSession.sessionName, windowIndex: currentWindowIndex });
                queryClient.setQueryData<ContainerListResponse>(['containers'], (old) => {
                  if (!old) return old;
                  return {
                    ...old,
                    containers: old.containers.map((c) =>
                      c.id !== selectedSession.containerId ? c : {
                        ...c,
                        sessions: c.sessions.map((s) =>
                          s.id !== session.id ? s : {
                            ...s,
                            windows: s.windows.map((w) => {
                              if (w.index === currentWindowIndex) return { ...w, index: targetWindowIndex };
                              if (w.index === targetWindowIndex) return { ...w, index: currentWindowIndex };
                              return w;
                            }).sort((a, b) => a.index - b.index),
                          }
                        ),
                      }
                    ),
                  };
                });
              }
            }
          }
        }
        return;
      }
      // Fold current session
      if (matchesBinding(e, hotkeys.foldSession)) {
        if (selectedSession) {
          e.preventDefault();
          const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
          if (containers) {
            const cId = selectedSession.containerId;
            const container = containers.find((c) => c.id === cId);
            if (container) {
              let session;
              if (isFoldedSelection(selectedSession)) {
                session = container.sessions.find((s) => s.id === selectedSession.sessionId);
              } else {
                session = container.sessions.find((s) => s.name === selectedSession.sessionName);
              }
              if (session && !isFoldedSelection(selectedSession)) {
                setSessionExpanded(cId, session.id, false);
                selectFoldedSession({
                  containerId: cId,
                  sessionName: session.name,
                  sessionId: session.id,
                  folded: true,
                });
              }
            }
          }
        }
        return;
      }
      // Unfold current session
      if (matchesBinding(e, hotkeys.unfoldSession)) {
        if (selectedSession && isFoldedSelection(selectedSession)) {
          e.preventDefault();
          const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
          if (containers) {
            const container = containers.find((c) => c.id === selectedSession.containerId);
            const session = container?.sessions.find((s) => s.id === selectedSession.sessionId);
            if (session) {
              setSessionExpanded(selectedSession.containerId, session.id, true);
              const sortedWindows = [...session.windows].sort((a, b) => a.index - b.index);
              if (sortedWindows.length > 0) {
                selectSession(selectedSession.containerId, session.name, sortedWindows[0].index);
              }
            }
          }
        }
        return;
      }
      // Navigate through windows AND folded sessions
      if (matchesBinding(e, hotkeys.nextItem) || matchesBinding(e, hotkeys.prevItem)) {
        const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
        if (containers && selectedSession) {
          e.preventDefault();
          const allItems: Selection[] = [];
          for (const c of containers) {
            if (c.status !== 'running' && !c.isHost && !c.isLocal) continue;
            if ((getContainerExpanded(c.id) ?? true) === false) continue;
            const ordered = sortSessionsByOrder(c.sessions, c.id);
            for (const s of ordered) {
              if (!isSessionExpanded(c.id, s.id)) {
                allItems.push({ containerId: c.id, sessionName: s.name, sessionId: s.id, folded: true });
              } else {
                const sortedWindows = [...s.windows].sort((a, b) => a.index - b.index);
                for (const w of sortedWindows) {
                  allItems.push({ containerId: c.id, sessionName: s.name, windowIndex: w.index });
                }
              }
            }
          }
          if (allItems.length > 0) {
            const curIdx = allItems.findIndex((t) => {
              if (isFoldedSelection(selectedSession) && isFoldedSelection(t)) {
                return t.containerId === selectedSession.containerId && t.sessionId === selectedSession.sessionId;
              }
              if (isWindowSelection(selectedSession) && isWindowSelection(t)) {
                return t.containerId === selectedSession.containerId &&
                       t.sessionName === selectedSession.sessionName &&
                       t.windowIndex === selectedSession.windowIndex;
              }
              return false;
            });
            const delta = matchesBinding(e, hotkeys.nextItem) ? 1 : -1;
            const nextIdx = curIdx === -1 ? 0 : (curIdx + delta + allItems.length) % allItems.length;
            const next = allItems[nextIdx];
            if (isFoldedSelection(next)) {
              selectFoldedSession(next);
            } else {
              selectSession(next.containerId, next.sessionName, next.windowIndex);
            }
          }
        }
      }
      // Deselect (double-press)
      if (matchesDoublePressKey(e, hotkeys.deselect) && !switcherOpen && !helpOpen) {
        const now = Date.now();
        if (now - escTimestampRef.current < 500) {
          if (selectedSession === null && previewSession === null) {
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
  }, [switcherOpen, helpOpen, clearPreviewImmediate, selectedSession, previewSession, assignDigit, selectSession, selectFoldedSession, setSessionExpanded, isSessionExpanded, queryClient, digitByTargetKey, hotkeys]);

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
        isSessionExpanded={isSessionExpanded}
        setSessionExpanded={setSessionExpanded}
      />
      <div className="flex-1 bg-[#0a0a0a] flex flex-col min-w-0">
        {displayedSession && (() => {
          const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
          const container = containers?.find((c) => c.id === displayedSession.containerId);
          if (isFolded) {
            return (
              <div className="h-6 flex items-center px-3 text-[11px] text-gray-500 bg-[#0e0e0e] border-b border-gray-800/40 shrink-0 select-none gap-1">
                <span className="text-gray-400">{container?.displayName ?? displayedSession.containerId}</span>
                <span className="text-gray-700">/</span>
                <span className="text-gray-400">{displayedSession.sessionName}</span>
                <span className="text-gray-600 ml-1">(folded)</span>
              </div>
            );
          }
          const winSel = displayedSession as SessionTarget;
          const session = container?.sessions.find((s) => s.name === winSel.sessionName);
          const win = session?.windows.find((w) => w.index === winSel.windowIndex);
          return (
            <div className="h-6 flex items-center px-3 text-[11px] text-gray-500 bg-[#0e0e0e] border-b border-gray-800/40 shrink-0 select-none gap-1">
              <span className="text-gray-400">{container?.displayName ?? winSel.containerId}</span>
              <span className="text-gray-700">/</span>
              <span className="text-gray-400">{winSel.sessionName}</span>
              <span className="text-gray-700">/</span>
              <span className="text-gray-400">{winSel.windowIndex}: {win?.name ?? '?'}</span>
            </div>
          );
        })()}
        <div className="flex-1 min-h-0 relative">
          <TerminalPool
            ref={poolRef}
            entries={pool.entries}
            activeKey={activeKey}
            onOpenFile={(containerId, path) => setViewingFile({ containerId, path })}
          />
          {isFolded && isFoldedSelection(displayedSession!) && (
            <div className="absolute inset-0 z-20">
              <FoldedSessionPreview
                selection={displayedSession as FoldedSessionTarget}
                onUnfoldAndSelect={(windowIndex) => {
                  const sel = displayedSession as FoldedSessionTarget;
                  setSessionExpanded(sel.containerId, sel.sessionId, true);
                  selectSession(sel.containerId, sel.sessionName, windowIndex);
                }}
              />
            </div>
          )}
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
          {displayedSession && !isFolded && (
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

      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} hotkeys={hotkeys} />}

      {viewingFile && (
        <FileViewer
          containerId={viewingFile.containerId}
          path={viewingFile.path}
          onClose={() => { setViewingFile(null); requestAnimationFrame(() => poolRef.current?.focusActive()); }}
        />
      )}
    </div>
  );
}
