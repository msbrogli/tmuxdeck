import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sidebar } from '../components/Sidebar';
import { TerminalPool } from '../components/TerminalPool';
import type { TerminalPoolHandle } from '../components/TerminalPool';
import { SessionSwitcher } from '../components/SessionSwitcher';
import { KeyboardHelp } from '../components/KeyboardHelp';
import { FoldedSessionPreview } from '../components/FoldedSessionPreview';
import { Monitor, Maximize2, Eye, Trash2 } from 'lucide-react';
import { useToast } from '../components/ToastContainer';
import { useTerminalPool } from '../hooks/useTerminalPool';
import { useWindowShortcuts } from '../hooks/useWindowShortcuts';
import { useSessionExpandedState } from '../hooks/useSessionExpandedState';
import { useContainerExpandedState } from '../hooks/useContainerExpandedState';
import { api } from '../api/client';
import { logout } from '../api/httpClient';
import type { SessionTarget, Selection, FoldedSessionTarget, FoldedContainerTarget, Container, ContainerListResponse, Settings, ClaudeNotification, TmuxWindow, WorkspaceListResponse, WorkspaceMember } from '../types';
import { isWindowSelection, isFoldedSelection, isFoldedContainerSelection } from '../types';
import { sortSessionsByOrder } from '../utils/sessionOrder';
import { filterWorkspace } from '../utils/workspaceFilter';
import { getSelectedSession, saveSelectedSession, getActiveWorkspaceId, saveActiveWorkspaceId, getWorkspaceSelectedSession } from '../utils/sidebarState';
import { DEFAULT_HOTKEYS, matchesBinding, matchesDoublePressKey } from '../utils/hotkeys';
import { FoldedContainerPreview } from '../components/FoldedContainerPreview';
import { BridgeLatencyOverlay } from '../components/BridgeLatencyOverlay';

/**
 * Try to restore a saved selection from a folded container.
 * Returns true if restoration succeeded, false to fall back to default behavior.
 */
function restoreContainerSelection(
  container: Container,
  foldedContainer: FoldedContainerTarget,
  selectSession: (containerId: string, sessionName: string, windowIndex: number) => void,
  selectFoldedSession: (target: FoldedSessionTarget) => void,
  isSessionExpanded: (containerId: string, sessionId: string) => boolean,
): boolean {
  const saved = foldedContainer.lastSelection;
  if (!saved) return false;

  if (isFoldedSelection(saved)) {
    // Saved selection was a folded session — find session by id
    const session = container.sessions.find((s) => s.id === saved.sessionId);
    if (!session) return false;
    if (!isSessionExpanded(container.id, session.id)) {
      // Session is still folded → restore folded session (preserving lastWindowIndex)
      selectFoldedSession({
        containerId: container.id,
        sessionName: session.name,
        sessionId: session.id,
        folded: true,
        lastWindowIndex: saved.lastWindowIndex,
      });
    } else {
      // Session is now expanded → use lastWindowIndex if present, else first window
      const sortedWindows = [...session.windows].sort((a, b) => a.index - b.index);
      const savedWin = saved.lastWindowIndex != null
        ? sortedWindows.find((w) => w.index === saved.lastWindowIndex)
        : undefined;
      const targetIndex = savedWin ? savedWin.index : (sortedWindows.length > 0 ? sortedWindows[0].index : undefined);
      if (targetIndex != null) {
        selectSession(container.id, session.name, targetIndex);
      } else {
        return false;
      }
    }
    return true;
  }

  if (isWindowSelection(saved)) {
    // Saved selection was an expanded window — find session by name
    const session = container.sessions.find((s) => s.name === saved.sessionName);
    if (!session) return false;
    if (!isSessionExpanded(container.id, session.id)) {
      // Session is now folded → select folded session, remembering the window
      selectFoldedSession({
        containerId: container.id,
        sessionName: session.name,
        sessionId: session.id,
        folded: true,
        lastWindowIndex: saved.windowIndex,
      });
    } else {
      // Session is expanded — check if saved window still exists
      const sortedWindows = [...session.windows].sort((a, b) => a.index - b.index);
      const savedWin = sortedWindows.find((w) => w.index === saved.windowIndex);
      if (savedWin) {
        selectSession(container.id, session.name, savedWin.index);
      } else if (sortedWindows.length > 0) {
        selectSession(container.id, session.name, sortedWindows[0].index);
      } else {
        return false;
      }
    }
    return true;
  }

  return false;
}

function getInitialSession(): SessionTarget | null {
  try {
    const state = window.history.state?.usr as { selectSession?: SessionTarget } | null;
    if (state?.selectSession) {
      // Clear navigation state so it doesn't re-trigger
      window.history.replaceState({}, '');
      return state.selectSession;
    }
  } catch { /* ignore */ }
  // Restore from sessionStorage (per-tab persistence across reloads)
  return getSelectedSession();
}

export function MainPage() {
  const [selectedSession, setSelectedSession] = useState<Selection | null>(getInitialSession);
  const [previewSession, setPreviewSession] = useState<SessionTarget | null>(null);
  const { isSessionExpanded, setSessionExpanded } = useSessionExpandedState();
  const { isContainerExpanded, setContainerExpanded } = useContainerExpandedState();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [recentIds, setRecentIds] = useState<string[]>([]);
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
  const followTmux = (settings as Settings | undefined)?.followTmux ?? false;

  const pool = useTerminalPool({ maxSize: poolSize, idleTimeoutMs: 60_000 });

  // Derive what to display
  const displayedSession = previewSession ?? selectedSession;
  const isPreview = previewSession !== null;
  const isFolded = displayedSession !== null && isFoldedSelection(displayedSession);
  const isFoldedContainer = displayedSession !== null && isFoldedContainerSelection(displayedSession);

  // Derive activeKey — must match useTerminalPool's makeKey (container+session only)
  // When folded (session or container), hide all terminals
  const activeKey = displayedSession && !isFolded && !isFoldedContainer
    ? `${displayedSession.containerId}-${(displayedSession as SessionTarget).sessionName}`
    : null;

  // Keep pool's activeKey ref in sync (for LRU eviction protection)
  pool.setActiveKey(activeKey);

  // Ensure the displayed session always has a pool entry.
  // This handles the case where a same-session sibling preview evicts
  // the committed entry, and then preview clears — we need to recreate it.
  // useLayoutEffect avoids a visible blank frame.
  const poolEnsure = pool.ensure;
  useLayoutEffect(() => {
    if (displayedSession && isWindowSelection(displayedSession)) {
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

    // Auto-switch workspace if the selected session isn't in the current one
    const wsId = getActiveWorkspaceId();
    if (wsId !== 'all') {
      const wsData = queryClient.getQueryData<WorkspaceListResponse>(['workspaces']);
      const activeWs = wsData?.workspaces.find((w) => w.id === wsId);
      if (activeWs && !activeWs.isDefault) {
        const fullSessionId = `${containerId}:${sessionName}`;
        const sessionInWs = (members: WorkspaceMember[]) =>
          members.some((m) =>
            (m.type === 'source' && m.sourceId === containerId) ||
            (m.type === 'session' && m.sourceId === containerId && m.sessionId === fullSessionId)
          );
        if (!sessionInWs(activeWs.members)) {
          // Find another workspace that contains the session
          const target = wsData?.workspaces.find((w) => !w.isDefault && w.id !== wsId && sessionInWs(w.members));
          saveActiveWorkspaceId(target ? target.id : 'all');
        }
      }
    }

    // Ensure entry exists BEFORE setting selection — batched in same React update
    pool.ensure({ containerId, sessionName, windowIndex });
    setSelectedSession({ containerId, sessionName, windowIndex });
    const key = `${containerId}:${sessionName}:${windowIndex}`;
    setRecentIds((prev) => [
      key,
      ...prev.filter((id) => id !== key),
    ].slice(0, 20));
    requestAnimationFrame(() => poolRef.current?.focusActive());
  }, [clearPreviewImmediate, pool, queryClient]);

  const selectFoldedSession = useCallback((target: FoldedSessionTarget) => {
    clearPreviewImmediate();
    setSelectedSession(target);
  }, [clearPreviewImmediate]);

  const selectFoldedContainer = useCallback((target: FoldedContainerTarget) => {
    clearPreviewImmediate();
    setSelectedSession(target);
  }, [clearPreviewImmediate]);

  // Persist selected session to sessionStorage for per-tab reload persistence
  useEffect(() => {
    if (selectedSession && isWindowSelection(selectedSession)) {
      saveSelectedSession(selectedSession);
    } else {
      saveSelectedSession(null);
    }
  }, [selectedSession]);

  // When workspace changes, restore the last selected session for that workspace
  useEffect(() => {
    const handler = (e: Event) => {
      const wsId = (e as CustomEvent<string>).detail;
      const saved = getWorkspaceSelectedSession(wsId);
      if (saved) {
        pool.ensure(saved);
        setSelectedSession(saved);
        requestAnimationFrame(() => poolRef.current?.focusActive());
      }
    };
    window.addEventListener('workspace-changed', handler);
    return () => window.removeEventListener('workspace-changed', handler);
  }, [pool]);

  // Follow tmux window/session changes initiated from the terminal (e.g. C-B N, C-B S)
  const handleActiveWindowChanged = useCallback((containerId: string, sessionName: string, windowIndex: number) => {
    if (!followTmux) return;
    setSelectedSession((prev) => {
      if (
        prev &&
        isWindowSelection(prev) &&
        prev.containerId === containerId &&
        (prev.sessionName !== sessionName || prev.windowIndex !== windowIndex)
      ) {
        pool.ensure({ containerId, sessionName, windowIndex });
        return { containerId, sessionName, windowIndex };
      }
      return prev;
    });
  }, [pool, followTmux]);

  // Update sidebar window state (activity/bell flags) from terminal polling
  const handleWindowsChanged = useCallback((containerId: string, sessionName: string, windows: TmuxWindow[]) => {
    queryClient.setQueryData<ContainerListResponse>(['containers'], (old) => {
      if (!old) return old;
      return {
        ...old,
        containers: old.containers.map((c) => {
          if (c.id !== containerId) return c;
          return {
            ...c,
            sessions: c.sessions.map((s) => {
              if (s.name !== sessionName) return s;
              return { ...s, windows };
            }),
          };
        }),
      };
    });
  }, [queryClient]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    };
  }, []);

  // Clear preview when switching browser tabs to prevent stale preview on return
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearPreviewImmediate();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [clearPreviewImmediate]);

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

          // Build a descriptive title including terminal identification
          const containers = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
          const container = containers?.find(c => c.id === notif.containerId);
          const containerName = container?.displayName ?? notif.containerId;
          const sessionLabel = notif.tmuxSession != null
            ? `${containerName} · ${notif.tmuxSession}:${notif.tmuxWindow ?? 0}`
            : (notif.title || 'Claude Code');

          // Show in-app toast if web channel enabled
          if (showWeb) {
            addToast({
              title: sessionLabel,
              message: notif.message || notif.title || 'Needs attention',
              onClick: notif.containerId && notif.tmuxSession != null
                ? () => selectSession(notif.containerId, notif.tmuxSession, notif.tmuxWindow ?? 0)
                : undefined,
            });
          }

          // Fire browser notification if os channel enabled and permission granted
          if (showOs && 'Notification' in window) {
            if (Notification.permission === 'granted') {
              const n = new window.Notification(sessionLabel, {
                body: notif.message || notif.title || 'Needs attention',
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
  }, [selectSession, addToast, queryClient]);

  const escTimestampRef = useRef<number>(0);

  // Merge user hotkeys with defaults
  const hotkeys = { ...DEFAULT_HOTKEYS, ...(settings as Settings | undefined)?.hotkeys };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Close shortcuts modal on ESC
      if (shortcutsOpen && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen(false);
        return;
      }
      if (matchesBinding(e, hotkeys.quickSwitch)) {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
      if (matchesBinding(e, hotkeys.showHelp)) {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
      if (matchesBinding(e, hotkeys.clearBuffer)) {
        e.preventDefault();
        poolRef.current?.clearBufferActive();
        return;
      }
      const digitMatch = e.code.match(/^Digit(\d)$/);
      if (digitMatch && (e.ctrlKey || e.metaKey)) {
        const digit = digitMatch[1];
        e.preventDefault();
        if (digit === '0' && !e.altKey) {
          // Ctrl+0: show shortcuts overview
          setShortcutsOpen((v) => !v);
        } else if (e.altKey) {
          // Ctrl+Alt+N: assign digit — only when a window is selected
          if (selectedSession && isWindowSelection(selectedSession)) assignDigit(digit, selectedSession, getActiveWorkspaceId());
        } else {
          const target = shortcutMapRef.current[digit];
          if (target) {
            // Switch workspace if the shortcut was assigned in a different one
            if (target.workspaceId) {
              saveActiveWorkspaceId(target.workspaceId);
            }
            selectSession(target.containerId, target.sessionName, target.windowIndex);
          }
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
      // Fold source (container) directly
      if (matchesBinding(e, hotkeys.foldSource)) {
        if (selectedSession) {
          e.preventDefault();
          setContainerExpanded(selectedSession.containerId, false);
          const lastSelection = isFoldedContainerSelection(selectedSession) ? undefined : selectedSession;
          selectFoldedContainer({ containerId: selectedSession.containerId, containerFolded: true, lastSelection });
        }
        return;
      }
      // Unfold source (container) directly
      if (matchesBinding(e, hotkeys.unfoldSource)) {
        if (selectedSession && isFoldedContainerSelection(selectedSession)) {
          e.preventDefault();
          const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
          if (containers) {
            const container = containers.find((c) => c.id === selectedSession.containerId);
            if (container) {
              setContainerExpanded(selectedSession.containerId, true);
              if (!restoreContainerSelection(container, selectedSession, selectSession, selectFoldedSession, isSessionExpanded)) {
                const ordered = sortSessionsByOrder(container.sessions, queryClient.getQueryData<string[]>(['sessionOrder', container.id]) ?? []);
                if (ordered.length > 0) {
                  const firstSession = ordered[0];
                  if (!isSessionExpanded(container.id, firstSession.id)) {
                    selectFoldedSession({
                      containerId: container.id,
                      sessionName: firstSession.name,
                      sessionId: firstSession.id,
                      folded: true,
                    });
                  } else {
                    const sortedWindows = [...firstSession.windows].sort((a, b) => a.index - b.index);
                    if (sortedWindows.length > 0) {
                      selectSession(container.id, firstSession.name, sortedWindows[0].index);
                    }
                  }
                }
              }
            }
          }
        }
        return;
      }
      // Fold current session / container
      if (matchesBinding(e, hotkeys.foldSession)) {
        if (selectedSession) {
          e.preventDefault();
          if (isFoldedContainerSelection(selectedSession)) {
            // Container header selected → fold it if expanded
            if (isContainerExpanded(selectedSession.containerId)) {
              setContainerExpanded(selectedSession.containerId, false);
            }
          } else if (isFoldedSelection(selectedSession)) {
            if (isSessionExpanded(selectedSession.containerId, selectedSession.sessionId)) {
              // Expanded session → fold the session
              setSessionExpanded(selectedSession.containerId, selectedSession.sessionId, false);
            } else {
              // Folded session → fold the container
              setContainerExpanded(selectedSession.containerId, false);
              selectFoldedContainer({ containerId: selectedSession.containerId, containerFolded: true, lastSelection: selectedSession });
            }
          } else {
            // Window selected → fold the session
            const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
            if (containers) {
              const cId = selectedSession.containerId;
              const container = containers.find((c) => c.id === cId);
              if (container) {
                const session = container.sessions.find((s) => s.name === selectedSession.sessionName);
                if (session) {
                  setSessionExpanded(cId, session.id, false);
                  selectFoldedSession({
                    containerId: cId,
                    sessionName: session.name,
                    sessionId: session.id,
                    folded: true,
                    lastWindowIndex: selectedSession.windowIndex,
                  });
                }
              }
            }
          }
        }
        return;
      }
      // Unfold current session / container
      if (matchesBinding(e, hotkeys.unfoldSession)) {
        if (selectedSession && isFoldedContainerSelection(selectedSession)) {
          if (!isContainerExpanded(selectedSession.containerId)) {
            // Folded container → expand it, restore saved selection or select first session
            e.preventDefault();
            const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
            if (containers) {
              const container = containers.find((c) => c.id === selectedSession.containerId);
              if (container) {
                setContainerExpanded(selectedSession.containerId, true);
                if (restoreContainerSelection(container, selectedSession, selectSession, selectFoldedSession, isSessionExpanded)) {
                  // restored
                } else {
                  const ordered = sortSessionsByOrder(container.sessions, queryClient.getQueryData<string[]>(['sessionOrder', container.id]) ?? []);
                  if (ordered.length > 0) {
                    const firstSession = ordered[0];
                    if (!isSessionExpanded(container.id, firstSession.id)) {
                      selectFoldedSession({
                        containerId: container.id,
                        sessionName: firstSession.name,
                        sessionId: firstSession.id,
                        folded: true,
                      });
                    } else {
                      const sortedWindows = [...firstSession.windows].sort((a, b) => a.index - b.index);
                      if (sortedWindows.length > 0) {
                        selectSession(container.id, firstSession.name, sortedWindows[0].index);
                      }
                    }
                  }
                }
              }
            }
          }
          // else: already expanded → no-op
        } else if (selectedSession && isFoldedSelection(selectedSession)) {
          if (!isSessionExpanded(selectedSession.containerId, selectedSession.sessionId)) {
            // Folded session → expand it, restore saved window or select first
            e.preventDefault();
            const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
            if (containers) {
              const container = containers.find((c) => c.id === selectedSession.containerId);
              const session = container?.sessions.find((s) => s.id === selectedSession.sessionId);
              if (session) {
                setSessionExpanded(selectedSession.containerId, session.id, true);
                const sortedWindows = [...session.windows].sort((a, b) => a.index - b.index);
                const savedWin = selectedSession.lastWindowIndex != null
                  ? sortedWindows.find((w) => w.index === selectedSession.lastWindowIndex)
                  : undefined;
                const targetIndex = savedWin ? savedWin.index : (sortedWindows.length > 0 ? sortedWindows[0].index : undefined);
                if (targetIndex != null) {
                  selectSession(selectedSession.containerId, session.name, targetIndex);
                }
              }
            }
          }
          // else: already expanded → no-op
        }
        return;
      }
      // Navigate through windows, folded sessions, AND folded containers
      if (matchesBinding(e, hotkeys.nextItem) || matchesBinding(e, hotkeys.prevItem)) {
        const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
        if (containers && selectedSession) {
          e.preventDefault();

          // Apply workspace filtering
          const wsId = getActiveWorkspaceId();
          const wsData = queryClient.getQueryData<WorkspaceListResponse>(['workspaces']);
          const activeWs = wsData?.workspaces.find((w) => w.id === wsId);
          const wsFilter = activeWs && !activeWs.isDefault ? filterWorkspace(activeWs.members, containers) : null;

          const allItems: Selection[] = [];
          for (const c of containers) {
            if (c.status !== 'running' && c.containerType !== 'host' && c.containerType !== 'local' && c.containerType !== 'bridge') continue;
            // Skip containers not in the active workspace
            if (wsFilter && !wsFilter.visibleContainerIds.has(c.id)) continue;
            // Always add container header (it's always visible)
            allItems.push({ containerId: c.id, containerFolded: true });
            if (!isContainerExpanded(c.id)) continue;
            const ordered = sortSessionsByOrder(c.sessions, queryClient.getQueryData<string[]>(['sessionOrder', c.id]) ?? []);
            const visibleSessions = wsFilter?.visibleSessions.get(c.id);
            for (const s of ordered) {
              // Skip sessions not in the active workspace
              if (visibleSessions && visibleSessions !== 'all' && !visibleSessions.has(s.id)) continue;
              // Always add session header (visible when container is expanded)
              allItems.push({ containerId: c.id, sessionName: s.name, sessionId: s.id, folded: true });
              if (isSessionExpanded(c.id, s.id)) {
                const sortedWindows = [...s.windows].sort((a, b) => a.index - b.index);
                for (const w of sortedWindows) {
                  allItems.push({ containerId: c.id, sessionName: s.name, windowIndex: w.index });
                }
              }
            }
          }
          if (allItems.length > 0) {
            const curIdx = allItems.findIndex((t) => {
              if (isFoldedContainerSelection(selectedSession) && isFoldedContainerSelection(t)) {
                return t.containerId === selectedSession.containerId;
              }
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
            if (isFoldedContainerSelection(next)) {
              selectFoldedContainer(next);
            } else if (isFoldedSelection(next)) {
              selectFoldedSession(next);
            } else {
              selectSession(next.containerId, next.sessionName, next.windowIndex);
            }
          }
        }
      }
      // Deselect (double-press)
      if (matchesDoublePressKey(e, hotkeys.deselect) && !switcherOpen && !helpOpen && !shortcutsOpen) {
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
  }, [switcherOpen, helpOpen, shortcutsOpen, clearPreviewImmediate, selectedSession, previewSession, assignDigit, selectSession, selectFoldedSession, selectFoldedContainer, setSessionExpanded, isSessionExpanded, setContainerExpanded, isContainerExpanded, queryClient, digitByTargetKey, hotkeys]);

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
        isContainerExpanded={isContainerExpanded}
        setContainerExpanded={setContainerExpanded}
      />
      <div className="flex-1 bg-[#0a0a0a] flex flex-col min-w-0">
        {displayedSession && (() => {
          const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
          const container = containers?.find((c) => c.id === displayedSession.containerId);
          if (isFoldedContainer) {
            return (
              <div className="h-6 flex items-center px-3 text-[11px] text-gray-500 bg-[#0e0e0e] border-b border-gray-800/40 shrink-0 select-none gap-1">
                <span className="text-gray-400">{container?.displayName ?? displayedSession.containerId}</span>
                <span className="text-gray-600 ml-1">(folded)</span>
              </div>
            );
          }
          if (isFolded) {
            return (
              <div className="h-6 flex items-center px-3 text-[11px] text-gray-500 bg-[#0e0e0e] border-b border-gray-800/40 shrink-0 select-none gap-1">
                <span className="text-gray-400">{container?.displayName ?? displayedSession.containerId}</span>
                <span className="text-gray-700">/</span>
                <span className="text-gray-400">{(displayedSession as FoldedSessionTarget).sessionName}</span>
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
            onActiveWindowChanged={handleActiveWindowChanged}
            onWindowsChanged={handleWindowsChanged}
          />
          {isFoldedContainer && isFoldedContainerSelection(displayedSession!) && (
            <div className="absolute inset-0 z-20">
              <FoldedContainerPreview
                selection={displayedSession as FoldedContainerTarget}
                onUnfoldAndSelect={(sessionIdx) => {
                  const sel = displayedSession as FoldedContainerTarget;
                  const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
                  const container = containers?.find((c) => c.id === sel.containerId);
                  if (container) {
                    setContainerExpanded(sel.containerId, true);
                    const ordered = sortSessionsByOrder(container.sessions, queryClient.getQueryData<string[]>(['sessionOrder', container.id]) ?? []);
                    const session = ordered[sessionIdx];
                    if (session) {
                      if (!isSessionExpanded(container.id, session.id)) {
                        selectFoldedSession({
                          containerId: container.id,
                          sessionName: session.name,
                          sessionId: session.id,
                          folded: true,
                        });
                      } else {
                        const sortedWindows = [...session.windows].sort((a, b) => a.index - b.index);
                        if (sortedWindows.length > 0) {
                          selectSession(container.id, session.name, sortedWindows[0].index);
                        }
                      }
                    }
                  }
                }}
              />
            </div>
          )}
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
          {displayedSession && !isFolded && !isFoldedContainer && (
            <div className="absolute top-2 right-2 z-30 flex items-center gap-1 group/toolbar">
              <div className="flex items-center gap-1 opacity-0 group-hover/toolbar:opacity-100 focus-within:opacity-100 transition-opacity">
                <button
                  onClick={() => { poolRef.current?.clearBufferActive(); poolRef.current?.focusActive(); }}
                  className="p-1.5 rounded bg-gray-800/80 text-gray-500 hover:text-gray-200 hover:bg-gray-700/90 transition-colors"
                  title="Clear terminal buffer"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  onClick={() => {
                    poolRef.current?.refitActive();
                    poolRef.current?.focusActive();
                  }}
                  className="p-1.5 rounded bg-gray-800/80 text-gray-500 hover:text-gray-200 hover:bg-gray-700/90 transition-colors"
                  title="Fit terminal to window"
                >
                  <Maximize2 size={14} />
                </button>
              </div>
              {displayedSession.containerId.startsWith('bridge:') && (
                <BridgeLatencyOverlay bridgeId={displayedSession.containerId.split(':')[1]} />
              )}
            </div>
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

      {shortcutsOpen && (
        <ShortcutsOverview
          map={shortcutMap}
          onClose={() => setShortcutsOpen(false)}
          onSelect={(target) => {
            setShortcutsOpen(false);
            if (target.workspaceId) saveActiveWorkspaceId(target.workspaceId);
            selectSession(target.containerId, target.sessionName, target.windowIndex);
          }}
        />
      )}

    </div>
  );
}

function ShortcutsOverview({
  map,
  onClose,
  onSelect,
}: {
  map: Record<string, SessionTarget & { workspaceId?: string }>;
  onClose: () => void;
  onSelect: (target: SessionTarget & { workspaceId?: string }) => void;
}) {
  const digits = Object.keys(map).sort();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">Quick Switch Shortcuts</h2>
          <p className="text-xs text-gray-500 mt-0.5">Ctrl+Alt+N to assign, Ctrl+N to jump</p>
        </div>
        <div className="py-1 max-h-72 overflow-y-auto">
          {digits.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-600">
              No shortcuts assigned yet.
              <br />
              <span className="text-xs">Select a window and press Ctrl+Alt+1-9</span>
            </div>
          ) : (
            digits.map((digit) => {
              const target = map[digit];
              return (
                <button
                  key={digit}
                  onClick={() => onSelect(target)}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-gray-400 hover:bg-gray-800/60 transition-colors"
                >
                  <kbd className="text-xs font-mono font-medium bg-gray-700 text-yellow-400 rounded px-1.5 py-0.5 shrink-0">
                    {digit}
                  </kbd>
                  <span className="text-sm truncate flex-1">
                    {target.containerId}/{target.sessionName}:{target.windowIndex}
                  </span>
                  {target.workspaceId && target.workspaceId !== 'all' && (
                    <span className="text-[10px] text-gray-600 shrink-0">{target.workspaceId}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600">
          <kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">Ctrl+0</kbd> toggle &middot;{' '}
          <kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">ESC</kbd> close
        </div>
      </div>
    </div>
  );
}
