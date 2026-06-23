import { useEffect, useRef, useImperativeHandle, useCallback, forwardRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ILinkProvider, ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Keyboard, Type, MousePointer2, Copy, ClipboardPaste } from 'lucide-react';
import { useToast } from './ToastContainer';
import { getNaturalTouchScroll } from '../utils/sidebarState';
import '@xterm/xterm/css/xterm.css';

const IS_TOUCH_DEVICE = typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export interface TerminalHandle {
  focus: () => void;
  refit: () => void;
  clearBuffer: () => void;
}

interface TerminalProps {
  containerId: string;
  sessionName: string;
  windowIndex: number;
  autoFocus?: boolean;
  visible?: boolean;
  onOpenFile?: (path: string) => void;
  onDownloadFile?: (path: string) => void;
  onReady?: () => void;
  onSessionGone?: () => void;
  onActiveWindowChanged?: (sessionName: string, windowIndex: number) => void;
  onWindowsChanged?: (sessionName: string, windows: import('../types').TmuxWindow[]) => void;
}

const IS_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_BACKOFF_FACTOR = 1.5;
const RECONNECT_MAX_ATTEMPTS = 15;

const THEME = {
  background: '#0a0a0a',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: '#3b82f680',
  black: '#09090b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#71717a',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
};

// --- Wrapped-line helpers for URL detection and text selection ---

const URL_RE = /https?:\/\/[^\s"'<>{}|\\^`[\]]+/g;

/**
 * Given a buffer row, find the first and last row of the soft-wrapped block
 * and return the joined text plus the start row index.
 */
function getWrappedBlock(term: XTerm, bufferRow: number): { text: string; startRow: number; rowLengths: number[] } {
  const buf = term.buffer.active;
  let startRow = bufferRow;
  // Walk backward to find the first row of the wrapped block
  while (startRow > 0) {
    const line = buf.getLine(startRow);
    if (!line || !line.isWrapped) break;
    startRow--;
  }
  // Walk forward to collect all rows
  const rowLengths: number[] = [];
  let text = '';
  let row = startRow;
  while (row < buf.length) {
    const line = buf.getLine(row);
    if (!line) break;
    if (row > startRow && !line.isWrapped) break;
    const rowText = line.translateToString();
    rowLengths.push(rowText.length);
    text += rowText;
    row++;
  }
  return { text, startRow, rowLengths };
}

/**
 * Custom link provider that detects URLs across soft-wrapped lines.
 */
function createWrappedLinkProvider(term: XTerm): ILinkProvider {
  return {
    provideLinks(y: number, cb: (links: ILink[] | undefined) => void) {
      const buf = term.buffer.active;
      const bufferRow = y - 1; // xterm API: y is 1-based
      const line = buf.getLine(bufferRow);
      if (!line) { cb(undefined); return; }

      const { text, startRow, rowLengths } = getWrappedBlock(term, bufferRow);

      const links: ILink[] = [];
      let match: RegExpExecArray | null;
      URL_RE.lastIndex = 0;
      while ((match = URL_RE.exec(text)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;
        const url = match[0];

        // Map character offset to (row, col)
        let offset = 0;
        let linkStartRow = startRow;
        let linkStartCol = 0;
        for (let i = 0; i < rowLengths.length; i++) {
          if (offset + rowLengths[i] > matchStart) {
            linkStartRow = startRow + i;
            linkStartCol = matchStart - offset;
            break;
          }
          offset += rowLengths[i];
        }

        offset = 0;
        let linkEndRow = startRow;
        let linkEndCol = 0;
        for (let i = 0; i < rowLengths.length; i++) {
          if (offset + rowLengths[i] >= matchEnd) {
            linkEndRow = startRow + i;
            linkEndCol = matchEnd - offset;
            break;
          }
          offset += rowLengths[i];
        }

        // Only include links that touch the requested row
        if (linkStartRow <= bufferRow && linkEndRow >= bufferRow) {
          links.push({
            range: {
              start: { x: linkStartCol + 1, y: linkStartRow + 1 },
              end: { x: linkEndCol, y: linkEndRow + 1 },
            },
            text: url,
            activate() {
              window.open(url, '_blank', 'noopener');
            },
          });
        }
      }
      cb(links.length > 0 ? links : undefined);
    },
  };
}

function setupMockTerminal(term: XTerm, containerId: string, sessionName: string) {
  term.writeln(`\x1b[1;34m[TmuxDeck]\x1b[0m Connected to \x1b[1;32m${sessionName}\x1b[0m in container \x1b[1;33m${containerId.slice(0, 12)}\x1b[0m`);
  term.writeln('');

  let currentLine = '';
  const writePrompt = () => {
    term.write(`\x1b[1;32muser@${sessionName}\x1b[0m:\x1b[1;34m/workspace\x1b[0m$ `);
  };
  writePrompt();

  term.onData((data) => {
    if (data === '\r') {
      term.writeln('');
      if (currentLine.trim()) {
        if (currentLine.trim() === 'clear') {
          term.clear();
        } else if (currentLine.trim() === 'help') {
          term.writeln('\x1b[1mMock Terminal\x1b[0m - This is a simulated terminal.');
          term.writeln('In production, this connects to a real tmux session via WebSocket.');
          term.writeln('');
          term.writeln('Try: ls, pwd, whoami, date, echo <text>');
        } else if (currentLine.trim() === 'ls') {
          term.writeln('\x1b[1;34msrc\x1b[0m  \x1b[1;34mnode_modules\x1b[0m  package.json  tsconfig.json  README.md');
        } else if (currentLine.trim() === 'pwd') {
          term.writeln('/workspace');
        } else if (currentLine.trim() === 'whoami') {
          term.writeln('root');
        } else if (currentLine.trim() === 'date') {
          term.writeln(new Date().toString());
        } else if (currentLine.trim().startsWith('tmuxdeck-open ')) {
          const file = currentLine.trim().slice('tmuxdeck-open '.length).trim();
          if (file) {
            // Write the OSC 7337 sequence so the registered handler fires
            const absPath = file.startsWith('/') ? file : `/workspace/${file}`;
            term.write(`\x1b]7337;${absPath}\x07`);
          } else {
            term.writeln('Usage: tmuxdeck-open <file>');
          }
        } else if (currentLine.trim().startsWith('echo ')) {
          term.writeln(currentLine.trim().slice(5));
        } else {
          term.writeln(`bash: ${currentLine.trim().split(' ')[0]}: command not found`);
        }
      }
      currentLine = '';
      writePrompt();
    } else if (data === '\x7f') {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        term.write('\b \b');
      }
    } else if (data >= ' ') {
      currentLine += data;
      term.write(data);
    }
  });
}

interface BellWarning {
  bellAction?: string;
  visualBell?: string;
}

function connectWebSocket(
  wsUrl: string,
  term: XTerm,
  fitAddon: FitAddon,
  onMouseWarning: (enabled: boolean) => void,
  onBellWarning: (warning: BellWarning | null) => void,
  onConnected: (ws: WebSocket) => void,
  onDisconnected: (code?: number) => void,
  onFirstData?: () => void,
  onSessionGone?: () => void,
  onActiveWindowChanged?: (sessionName: string, windowIndex: number) => void,
  onWindowsChanged?: (sessionName: string, windows: import('../types').TmuxWindow[]) => void,
  windowIndexRef?: { current: number },
): { ws: WebSocket; close: () => void } {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  let firedFirstData = false;

  ws.onopen = () => {
    onConnected(ws);
    // Defer RESIZE so the fit cycle measures the DOM first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            ws.send(`RESIZE:${dims.cols}:${dims.rows}`);
          }
        }
      });
    });
  };

  ws.onmessage = (event) => {
    if (!firedFirstData) {
      firedFirstData = true;
      onFirstData?.();
    }
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else {
      const text = event.data as string;
      if (text === 'SESSION_GONE:') {
        onSessionGone?.();
        return;
      }
      if (text === 'BRIDGE_RECONNECTING:') {
        term.writeln('\r\n\x1b[1;33m[Bridge reconnecting...]\x1b[0m');
        return;
      }
      if (text.startsWith('MOUSE_WARNING:')) {
        onMouseWarning(text === 'MOUSE_WARNING:on');
        return;
      }
      if (text.startsWith('BELL_WARNING:')) {
        const payload = text.slice('BELL_WARNING:'.length);
        if (payload === 'ok') {
          onBellWarning(null);
        } else {
          try {
            onBellWarning(JSON.parse(payload) as BellWarning);
          } catch { /* ignore malformed */ }
        }
        return;
      }
      if (text.startsWith('WINDOW_STATE:')) {
        try {
          const state = JSON.parse(text.slice('WINDOW_STATE:'.length));
          const active = state.active;
          const session = state.session;
          if (typeof active === 'number' && typeof session === 'string' && onActiveWindowChanged) {
            // Update ref first to prevent redundant SELECT_WINDOW when prop changes
            if (windowIndexRef) windowIndexRef.current = active;
            onActiveWindowChanged(session, active);
          }
          if (typeof session === 'string' && Array.isArray(state.windows) && onWindowsChanged) {
            onWindowsChanged(session, state.windows);
          }
        } catch { /* ignore malformed */ }
        return;
      }
      term.write(text);
    }
  };

  ws.onerror = () => {
    // Error is always followed by a close event; reconnect logic lives there.
  };

  ws.onclose = (event) => {
    onDisconnected(event.code);
  };

  const close = () => {
    // Null out onclose before closing to prevent triggering reconnect
    ws.onclose = null;
    ws.close();
  };

  return { ws, close };
}

function setupWebSocketTerminal(
  term: XTerm,
  fitAddon: FitAddon,
  containerId: string,
  sessionName: string,
  _windowIndex: number,
  onMouseWarning: (enabled: boolean) => void,
  onBellWarning: (warning: BellWarning | null) => void,
  wsRef: { current: WebSocket | null },
  windowIndexRef: { current: number },
  _osc52TextRef: { current: string | null },
  onFirstData?: () => void,
  onSessionGone?: () => void,
  onActiveWindowChangedGetter?: () => ((sessionName: string, windowIndex: number) => void) | undefined,
  onWindowsChangedGetter?: () => ((sessionName: string, windows: import('../types').TmuxWindow[]) => void) | undefined,
): { cleanup: () => void; inScrollMode: { current: boolean } } {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let hasConnectedOnce = false;
  let tapToReconnectActive = false;
  let currentClose: (() => void) | null = null;
  let sessionGone = false;
  // Fast-close heuristic: track consecutive quick closes with no data
  let consecutiveQuickCloses = 0;

  const inScrollMode = { current: false };

  // Register xterm.js disposables once — they all read wsRef.current
  const dataDisposable = term.onData((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  const binaryDisposable = term.onBinary((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const buffer = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        buffer[i] = data.charCodeAt(i) & 0xff;
      }
      ws.send(buffer);
    }
  });

  const resizeDisposable = term.onResize(({ cols, rows }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(`RESIZE:${cols}:${rows}`);
    }
  });

  // Exit scroll mode when the user types any key
  const scrollExitDisposable = term.onData(() => {
    if (inScrollMode.current) {
      inScrollMode.current = false;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('SCROLL:exit');
      }
    }
  });

  // Intercept Shift+Enter and copy/paste shortcuts
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      if (e.type === 'keydown') {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send('SHIFT_ENTER:');
        }
      }
      return false;
    }

    if (e.type !== 'keydown') return true;

    // iPad Safari with Bluetooth keyboard intercepts Ctrl+key as system
    // shortcuts (e.g. Ctrl+C → Copy). Prevent that and send the control
    // character directly to the terminal.
    if (isIOS && e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      const ch = e.key.toLowerCase();
      if (ch >= 'a' && ch <= 'z') {
        e.preventDefault();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(String.fromCharCode(ch.charCodeAt(0) - 96));
        }
        return false;
      }
    }

    // iPadOS treats ESC as "Home" button with external keyboards.
    // Prevent that and let xterm.js handle the key normally.
    if (isIOS && e.key === 'Escape') {
      e.preventDefault();
      return true; // let xterm.js process ESC
    }

    if (e.key === 'c' || e.key === 'C') {
      const shouldCopy = isMac ? (e.metaKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey);
      if (shouldCopy && term.hasSelection()) {
        copyToClipboard(term.getSelection());
        return false;
      }
    }

    if (e.key === 'v' || e.key === 'V') {
      const shouldPaste = isMac ? (e.metaKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey);
      if (shouldPaste) {
        // Let the native paste event flow to handlePaste capture listener.
        // This avoids navigator.clipboard.readText() which triggers a permission
        // popup in Firefox and caused double-paste (both this handler and
        // handlePaste were calling term.paste()).
        return true;
      }
    }

    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pageLines = term.rows;
        if (e.key === 'PageUp') {
          inScrollMode.current = true;
          ws.send(`SCROLL:up:${pageLines}:page`);
        } else {
          ws.send(`SCROLL:down:${pageLines}:page`);
        }
      }
      return false;
    }

    if (inScrollMode.current && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (e.key === 'ArrowUp') {
          ws.send('SCROLL:up:1:line');
        } else {
          ws.send('SCROLL:down:1:line');
        }
      }
      return false;
    }

    return true;
  });

  function markSessionGone() {
    sessionGone = true;
    term.writeln('\r\n\x1b[1;31m[Terminal no longer exists]\x1b[0m');
    onSessionGone?.();
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null || sessionGone) return;
    if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      term.writeln('\r\n\x1b[1;31m[Connection lost \u2014 tap to reconnect]\x1b[0m');
      tapToReconnectActive = true;
      return;
    }
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt++;
    term.writeln('\r\n\x1b[1;33m[Reconnecting...]\x1b[0m');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) doConnect();
    }, delay);
  }

  function scheduleBridgeReconnect() {
    if (disposed || reconnectTimer !== null || sessionGone) return;
    // Bridge is temporarily unavailable — retry at max interval indefinitely.
    // Don't increment reconnectAttempt so normal reconnect limits stay intact
    // once the bridge comes back.
    const delay = RECONNECT_MAX_DELAY_MS;
    term.writeln('\r\n\x1b[1;33m[Bridge disconnected — waiting for reconnect...]\x1b[0m');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) doConnect();
    }, delay);
  }

  function doConnect() {
    if (disposed) return;
    // Close any in-progress connection attempt
    if (currentClose) {
      currentClose();
      currentClose = null;
    }
    wsRef.current = null;

    const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${containerId}/${sessionName}/${windowIndexRef.current}`;
    let connectTime = 0;
    let receivedData = false;
    const { close } = connectWebSocket(
      wsUrl,
      term,
      fitAddon,
      onMouseWarning,
      onBellWarning,
      (openWs) => {
        if (disposed) { close(); return; }
        wsRef.current = openWs;
        connectTime = Date.now();
        receivedData = false;
        if (hasConnectedOnce) {
          term.clear();
          term.writeln('\x1b[1;32m[Reconnected]\x1b[0m');
          // Re-sync tmux to the current window (the attach URL uses the
          // original windowIndex, which may differ after user navigation).
          openWs.send(`SELECT_WINDOW:${windowIndexRef.current}`);
        }
        hasConnectedOnce = true;
        reconnectAttempt = 0;
        tapToReconnectActive = false;
      },
      (code?: number) => {
        if (disposed) return;
        wsRef.current = null;
        // Backend explicitly told us the session is gone
        if (sessionGone || code === 4404) {
          if (!sessionGone) markSessionGone();
          return;
        }
        // Bridge not connected yet — keep retrying indefinitely with max
        // backoff delay.  Don't count toward fast-close or max-attempts
        // limits because the bridge may reconnect at any time.
        if (code === 4004) {
          consecutiveQuickCloses = 0;
          scheduleBridgeReconnect();
          return;
        }
        // Fast-close heuristic: if connection closed within 2s with no data,
        // the session may have vanished between has-session and attach.
        const elapsed = connectTime ? Date.now() - connectTime : Infinity;
        if (elapsed < 2000 && !receivedData) {
          consecutiveQuickCloses++;
          if (consecutiveQuickCloses >= 3) {
            markSessionGone();
            return;
          }
        } else {
          consecutiveQuickCloses = 0;
        }
        scheduleReconnect();
      },
      () => { receivedData = true; onFirstData?.(); },
      () => { if (!sessionGone) markSessionGone(); },
      onActiveWindowChangedGetter ? (session: string, idx: number) => onActiveWindowChangedGetter()?.(session, idx) : undefined,
      onWindowsChangedGetter ? (session: string, windows: import('../types').TmuxWindow[]) => onWindowsChangedGetter()?.(session, windows) : undefined,
      windowIndexRef,
    );
    currentClose = close;
  }

  // Tap-to-reconnect handler
  const xtermElement = term.element;
  const handleTapReconnect = () => {
    if (tapToReconnectActive && !disposed) {
      tapToReconnectActive = false;
      reconnectAttempt = 0;
      doConnect();
    }
  };
  xtermElement?.addEventListener('click', handleTapReconnect);

  // Visibility change handler — immediate reconnect on iPad wake.
  // Track when the page was hidden so we can force-reconnect even if
  // the WebSocket readyState still appears OPEN (stale socket).
  let hiddenAt = 0;
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (document.visibilityState !== 'visible' || disposed || sessionGone) return;
    const ws = wsRef.current;
    const wasHiddenLong = hiddenAt > 0 && (Date.now() - hiddenAt) > 2000;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING || wasHiddenLong) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      tapToReconnectActive = false;
      doConnect();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Initial connection
  doConnect();

  const cleanup = () => {
    disposed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    xtermElement?.removeEventListener('click', handleTapReconnect);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    dataDisposable.dispose();
    binaryDisposable.dispose();
    resizeDisposable.dispose();
    scrollExitDisposable.dispose();
    currentClose?.();
  };

  return { cleanup, inScrollMode };
}

/** Copy text to system clipboard — tries multiple strategies for iPad Safari.
 *  Returns a string describing which method succeeded (for debug feedback). */
async function copyToClipboard(text: string): Promise<string> {
  // Strategy 1: Clipboard API (works in user-gesture click handlers on modern Safari)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return 'Copied';
    } catch { /* fall through */ }
  }

  // Strategy 2: copy event interception
  {
    let ok = false;
    const handler = (e: ClipboardEvent) => {
      e.clipboardData!.setData('text/plain', text);
      e.preventDefault();
      ok = true;
    };
    document.addEventListener('copy', handler);
    document.execCommand('copy');
    document.removeEventListener('copy', handler);
    if (ok) return 'Copied (event)';
  }

  // Strategy 3: textarea selection (iOS fallback)
  {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.fontSize = '20px';
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.setSelectionRange(0, 999999);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return 'Copied (textarea)';
  }

  return 'Copy failed — all methods';
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];

async function uploadAndInject(
  blob: File | Blob,
  containerId: string,
  ws: WebSocket | null,
  term: XTerm | null,
) {
  const formData = new FormData();
  formData.append('file', blob, (blob as File).name || 'paste.png');
  try {
    const res = await fetch(`/api/v1/containers/${containerId}/upload-image`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      term?.writeln(`\r\n\x1b[1;31m[Image upload failed: ${msg}]\x1b[0m`);
      return;
    }
    const { path } = await res.json();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(path);
    }
  } catch (err) {
    term?.writeln(`\r\n\x1b[1;31m[Image upload error: ${err}]\x1b[0m`);
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function uploadFileAndInject(
  file: File,
  containerId: string,
  ws: WebSocket | null,
  term: XTerm | null,
) {
  const formData = new FormData();
  formData.append('file', file, file.name || 'upload.bin');
  try {
    const res = await fetch(`/api/v1/containers/${containerId}/upload-file`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      term?.writeln(`\r\n\x1b[1;31m[File upload failed: ${msg}]\x1b[0m`);
      return;
    }
    const { path } = await res.json();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(shellEscape(path));
    }
  } catch (err) {
    term?.writeln(`\r\n\x1b[1;31m[File upload error: ${err}]\x1b[0m`);
  }
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ containerId, sessionName, windowIndex, autoFocus = true, visible = true, onOpenFile, onDownloadFile, onReady, onSessionGone, onActiveWindowChanged, onWindowsChanged }, ref) {
  const { addToast } = useToast();
  const addToastRef = useRef(addToast);
  useEffect(() => { addToastRef.current = addToast; });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSentDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const windowIndexRef = useRef(windowIndex);
  const inScrollModeRef = useRef<{ current: boolean }>({ current: false });
  const onOpenFileRef = useRef(onOpenFile);
  const onDownloadFileRef = useRef(onDownloadFile);
  const onReadyRef = useRef(onReady);
  const onSessionGoneRef = useRef(onSessionGone);
  const onActiveWindowChangedRef = useRef(onActiveWindowChanged);
  const onWindowsChangedRef = useRef(onWindowsChanged);
  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
    onDownloadFileRef.current = onDownloadFile;
    onReadyRef.current = onReady;
    onSessionGoneRef.current = onSessionGone;
    onActiveWindowChangedRef.current = onActiveWindowChanged;
    onWindowsChangedRef.current = onWindowsChanged;
  });
  const [isDragging, setIsDragging] = useState(false);
  const [mouseWarning, setMouseWarning] = useState(false);
  const [bellWarning, setBellWarning] = useState<BellWarning | null>(null);
  const [showVirtualKeys, setShowVirtualKeys] = useState(IS_TOUCH_DEVICE);
  const [showTextInput, setShowTextInput] = useState(false);
  const textInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const prevInputRef = useRef('');
  const [selectMode, setSelectMode] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const pasteInputRef = useRef<HTMLInputElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const selectionTextRef = useRef('');
  const osc52TextRef = useRef<string | null>(null);
  const selectModeRef = useRef(false);
  useEffect(() => { selectModeRef.current = selectMode; });
  const selectStartRef = useRef<{ col: number; row: number } | null>(null);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  // Refs mirror modifier state for synchronous access in event handlers (avoids stale closures)
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const altRef = useRef(false);
  useEffect(() => {
    ctrlRef.current = ctrlActive;
    shiftRef.current = shiftActive;
    altRef.current = altActive;
  });

  // Send current size to backend — skips if dimensions haven't changed
  // unless `force` is true (e.g. initial connection).
  const sendResize = useCallback((force = false) => {
    const ws = wsRef.current;
    const fitAddon = fitAddonRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && fitAddon) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        const last = lastSentDimsRef.current;
        if (!force && last && last.cols === dims.cols && last.rows === dims.rows) {
          return; // dimensions unchanged — skip to avoid tmux full redraw
        }
        lastSentDimsRef.current = { cols: dims.cols, rows: dims.rows };
        ws.send(`RESIZE:${dims.cols}:${dims.rows}`);
      }
    }
  }, []);

  const doFit = useCallback((retries = 3) => {
    const attempt = (remaining: number) => {
      const container = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!container || !fitAddon) return;
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) {
        fitAddon.fit();
      } else if (remaining > 0) {
        // Container not yet laid out — retry next frame
        requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    attempt(retries);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    refit: () => {
      doFit();
      sendResize();
    },
    clearBuffer: () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('CLEAR_BUFFER:');
      }
      xtermRef.current?.clear();
    },
  }));

  useEffect(() => {
    if (!wrapperRef.current || !termRef.current) return;
    const wrapper = wrapperRef.current;
    const container = termRef.current;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: THEME,
      allowProposedApi: true,
      // Scrolling is handled server-side via tmux copy-mode, so xterm keeps no
      // history. Must stay 0: any non-zero scrollback makes FitAddon reserve
      // ~14px for a scrollbar (overviewRuler?.width || 14), leaving a dead gap
      // on the right that never fills, even on resize.
      scrollback: 0,
    });

    // Suppress audible bell — swallow the event so the browser stays silent.
    term.onBell(() => { /* noop */ });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // Custom link provider that detects URLs across soft-wrapped lines
    const linkDisposable = term.registerLinkProvider(createWrappedLinkProvider(term));

    // Register custom OSC 7337 handler for tmuxdeck-open
    const oscDisposable = term.parser.registerOscHandler(7337, (data) => {
      const filePath = data.trim();
      if (filePath) {
        onOpenFileRef.current?.(filePath);
      }
      return true;
    });

    // Register custom OSC 7338 handler for tmuxdeck-download
    const oscDownloadDisposable = term.parser.registerOscHandler(7338, (data) => {
      const filePath = data.trim();
      if (filePath) {
        onDownloadFileRef.current?.(filePath);
      }
      return true;
    });

    // Register OSC 52 handler for remote-to-local clipboard copy
    const osc52Disposable = term.parser.registerOscHandler(52, (data) => {
      // Format: "c;<base64>" or just "<base64>"
      const parts = data.split(';');
      const b64 = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      if (b64) {
        try {
          const text = atob(b64);
          osc52TextRef.current = text;
          const chars = `${text.length} character${text.length !== 1 ? 's' : ''}`;
          copyToClipboard(text).then((result) => {
            if (result.startsWith('Copy failed')) {
              addToastRef.current({
                title: 'Tap to copy to clipboard',
                message: chars,
                onClick: () => {
                  copyToClipboard(text).then(() => {
                    addToastRef.current({
                      title: 'Copied to clipboard',
                      message: chars,
                    });
                  });
                },
              });
            } else {
              addToastRef.current({
                title: 'Copied to clipboard',
                message: chars,
              });
            }
          });
        } catch { /* ignore decode errors */ }
      }
      return true;
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track text selection for Copy button (touch select mode)
    // Cache the selected text so it's available even if focus moves away.
    // Only update on new selection — never clear on deselect, because on iPad
    // tapping the Copy button clears the selection before onClick fires.
    const selectionDisposable = term.onSelectionChange(() => {
      const has = term.hasSelection();
      setHasSelection(has);
      if (has) selectionTextRef.current = term.getSelection();
    });

    // Triple-click on wrapped lines: select the entire wrapped block
    const handleTripleClick = (e: MouseEvent) => {
      if (e.detail !== 3) return;
      const buf = term.buffer.active;
      // Convert mouse Y to buffer row
      const cellHeight = container.clientHeight / term.rows;
      const viewportRow = Math.floor(e.offsetY / cellHeight);
      const bufferRow = buf.viewportY + viewportRow;
      const line = buf.getLine(bufferRow);
      if (!line) return;

      // Check if this row is part of a wrapped block (multi-row)
      const isPartOfWrap = line.isWrapped || (bufferRow + 1 < buf.length && buf.getLine(bufferRow + 1)?.isWrapped);
      if (!isPartOfWrap) return; // let default handle non-wrapped lines

      const { text, startRow, rowLengths } = getWrappedBlock(term, bufferRow);
      const totalLen = text.length;
      if (totalLen === 0 || rowLengths.length <= 1) return;

      // Select the entire wrapped block
      term.select(0, startRow, totalLen);
      e.preventDefault();
    };
    container.addEventListener('click', handleTripleClick);

    // Measure container (flex-sized) and fit terminal
    const fitAndResize = (retries = 3) => {
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) {
        fitAddon.fit();
      } else if (retries > 0) {
        requestAnimationFrame(() => fitAndResize(retries - 1));
      }
    };

    // Defer initial fit — use double-rAF to ensure layout has fully settled
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAndResize();
        // Force-send dimensions on initial connection (skip dedup)
        sendResize(true);
        if (autoFocus) term.focus();
      });
    });

    if (IS_MOCK) {
      setupMockTerminal(term, containerId, sessionName);
    } else {
      const { cleanup, inScrollMode } = setupWebSocketTerminal(term, fitAddon, containerId, sessionName, windowIndexRef.current, setMouseWarning, setBellWarning, wsRef, windowIndexRef, osc52TextRef, () => onReadyRef.current?.(), () => onSessionGoneRef.current?.(), () => onActiveWindowChangedRef.current ?? undefined, () => onWindowsChangedRef.current ?? undefined);
      inScrollModeRef.current = inScrollMode;
      // Store cleanup for unmount
      (wrapper as unknown as Record<string, () => void>).__wsCleanup = cleanup;
    }

    // Observe container (flex-sized) so fit triggers when toolbar toggles
    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(container);

    // --- Paste handler: intercept image and text pastes ---
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let hasText = false;
      let imageFile: File | null = null;
      for (const item of items) {
        if (item.type === 'text/plain') hasText = true;
        if (item.kind === 'file' && IMAGE_TYPES.includes(item.type)) {
          imageFile = item.getAsFile();
        }
      }
      if (imageFile && !hasText) {
        e.preventDefault();
        e.stopPropagation();
        uploadAndInject(imageFile, containerId, wsRef.current, term);
        return;
      }
      // Handle plain text paste (keyboard shortcut or iPad long-press → Paste popup)
      if (hasText) {
        const text = e.clipboardData?.getData('text/plain');
        if (text) {
          e.preventDefault();
          e.stopPropagation();
          term.paste(text);
        } else if (osc52TextRef.current) {
          e.preventDefault();
          e.stopPropagation();
          term.paste(osc52TextRef.current);
        }
      }
    };

    // --- Drag-and-drop handlers ---
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };
    const handleDragLeave = (e: DragEvent) => {
      // Only hide when leaving the wrapper itself
      if (e.currentTarget === wrapper && !wrapper.contains(e.relatedTarget as Node)) {
        setIsDragging(false);
      }
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!e.dataTransfer?.files) return;
      for (const file of e.dataTransfer.files) {
        if (IMAGE_TYPES.includes(file.type)) {
          uploadAndInject(file, containerId, wsRef.current, term);
        } else {
          uploadFileAndInject(file, containerId, wsRef.current, term);
        }
      }
    };

    // --- Wheel handler: forward scroll events to tmux ---
    // Use capture phase so we intercept before xterm.js handles the event
    let lastWheelTime = 0;
    const WHEEL_THROTTLE_MS = 50;
    const LINES_PER_TICK = 3;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastWheelTime < WHEEL_THROTTLE_MS) return;
      lastWheelTime = now;

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40) * LINES_PER_TICK);
      if (e.deltaY < 0) {
        // Scroll up
        inScrollModeRef.current.current = true;
        ws.send(`SCROLL:up:${lines}:line`);
      } else {
        // Scroll down
        ws.send(`SCROLL:down:${lines}:line`);
      }
    };

    // --- Touch scroll handlers ---
    let touchStartY = 0;
    let touchLastY = 0;
    let lastTouchTime = 0;
    let touchVelocity = 0;
    const TOUCH_THROTTLE_MS = 50;
    const PX_PER_LINE = 20;
    let momentumRafId = 0;

    // Convert touch coordinates to terminal cell position
    const touchToCell = (touchX: number, touchY: number) => {
      const screen = container.querySelector('.xterm-screen');
      if (!screen) return null;
      const rect = screen.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const cellHeight = rect.height / term.rows;
      return {
        col: Math.min(Math.max(Math.floor((touchX - rect.left) / cellWidth), 0), term.cols - 1),
        row: Math.min(Math.max(Math.floor((touchY - rect.top) / cellHeight), 0), term.rows - 1),
      };
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (selectModeRef.current) {
        const touch = e.touches[0];
        const cell = touchToCell(touch.clientX, touch.clientY);
        if (cell) {
          selectStartRef.current = cell;
          term.clearSelection();
        }
        return;
      }
      // Don't preventDefault — allow taps for keyboard focus
      touchStartY = e.touches[0].clientY;
      touchLastY = touchStartY;
      touchVelocity = 0;
      cancelAnimationFrame(momentumRafId);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (selectModeRef.current) {
        e.preventDefault(); // Prevent page scroll during selection
        const start = selectStartRef.current;
        if (!start) return;
        const touch = e.touches[0];
        const end = touchToCell(touch.clientX, touch.clientY);
        if (!end) return;

        // Normalize so sCol/sRow is before eCol/eRow
        let sCol = start.col, sRow = start.row, eCol = end.col, eRow = end.row;
        if (eRow < sRow || (eRow === sRow && eCol < sCol)) {
          [sCol, sRow, eCol, eRow] = [eCol, eRow, sCol, sRow];
        }
        const length = (eRow - sRow) * term.cols + (eCol - sCol + 1);
        if (length > 0) {
          term.select(sCol, sRow, length);
        }
        return;
      }

      const currentY = e.touches[0].clientY;
      const deltaFromStart = Math.abs(currentY - touchStartY);

      // Only treat as scroll if finger moved >10px
      if (deltaFromStart < 10) return;

      // Prevent iOS rubber-banding
      e.preventDefault();

      const now = Date.now();
      if (now - lastTouchTime < TOUCH_THROTTLE_MS) return;

      const deltaY = touchLastY - currentY;
      const elapsed = now - lastTouchTime || 1;
      touchVelocity = deltaY / elapsed; // px per ms
      lastTouchTime = now;
      touchLastY = currentY;

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const natural = getNaturalTouchScroll();
      const lines = Math.max(1, Math.round(Math.abs(deltaY) / PX_PER_LINE));
      const scrollUp = natural ? deltaY < 0 : deltaY > 0;
      if (scrollUp) {
        inScrollModeRef.current.current = true;
        ws.send(`SCROLL:up:${lines}:line`);
      } else {
        ws.send(`SCROLL:down:${lines}:line`);
      }
    };

    const handleTouchEnd = () => {
      if (selectModeRef.current) {
        selectStartRef.current = null;
        return;
      }

      // Momentum scrolling based on final velocity
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Math.abs(touchVelocity) < 0.3) return;

      const natural = getNaturalTouchScroll();
      let velocity = touchVelocity;
      const decay = () => {
        velocity *= 0.85;
        if (Math.abs(velocity) < 0.1) return;

        const lines = Math.max(1, Math.round(Math.abs(velocity * TOUCH_THROTTLE_MS) / PX_PER_LINE));
        const scrollUp = natural ? velocity < 0 : velocity > 0;
        if (scrollUp) {
          inScrollModeRef.current.current = true;
          ws.send(`SCROLL:up:${lines}:line`);
        } else {
          ws.send(`SCROLL:down:${lines}:line`);
        }
        momentumRafId = requestAnimationFrame(decay);
      };
      momentumRafId = requestAnimationFrame(decay);
    };

    wrapper.addEventListener('paste', handlePaste, { capture: true });
    wrapper.addEventListener('dragover', handleDragOver);
    wrapper.addEventListener('dragleave', handleDragLeave);
    wrapper.addEventListener('drop', handleDrop);
    wrapper.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    wrapper.addEventListener('touchstart', handleTouchStart, { passive: true });
    wrapper.addEventListener('touchmove', handleTouchMove, { passive: false });
    wrapper.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(momentumRafId);
      oscDisposable.dispose();
      oscDownloadDisposable.dispose();
      osc52Disposable.dispose();
      selectionDisposable.dispose();
      linkDisposable.dispose();
      container.removeEventListener('click', handleTripleClick);
      const cleanup = (wrapper as unknown as Record<string, (() => void) | undefined>).__wsCleanup;
      cleanup?.();
      wsRef.current = null;
      lastSentDimsRef.current = null;
      inScrollModeRef.current = { current: false };
      resizeObserver.disconnect();
      wrapper.removeEventListener('paste', handlePaste, { capture: true });
      wrapper.removeEventListener('dragover', handleDragOver);
      wrapper.removeEventListener('dragleave', handleDragLeave);
      wrapper.removeEventListener('drop', handleDrop);
      wrapper.removeEventListener('wheel', handleWheel, { capture: true });
      wrapper.removeEventListener('touchstart', handleTouchStart);
      wrapper.removeEventListener('touchmove', handleTouchMove);
      wrapper.removeEventListener('touchend', handleTouchEnd);
      term.dispose();
    };
  // windowIndex changes are handled by the SELECT_WINDOW effect below;
  // including it here would tear down the WebSocket connection instead of smoothly switching windows.
  }, [containerId, sessionName, autoFocus, sendResize]);

  // Switch tmux windows without recreating the connection.
  // When windowIndex changes (e.g. user clicks a different window in the sidebar),
  // we send a SELECT_WINDOW control message so tmux switches in-place.
  useEffect(() => {
    const prevIndex = windowIndexRef.current;
    windowIndexRef.current = windowIndex;
    if (prevIndex !== windowIndex) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(`SELECT_WINDOW:${windowIndex}`);
        // Force resize so tmux redraws the new window content at correct size
        sendResize(true);
      }
    }
  }, [windowIndex, sendResize]);

  // Refit when text input toolbar is toggled (changes wrapper padding)
  useEffect(() => {
    requestAnimationFrame(() => {
      doFit();
      sendResize();
    });
  }, [showTextInput, showVirtualKeys, doFit, sendResize]);

  // Refit when becoming visible, blur when hidden
  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current || !wrapperRef.current || !termRef.current) return;
    if (visible) {
      // Double-rAF: first frame processes the visibility CSS change,
      // second frame measures the now-visible element correctly
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          doFit();
          // Force tmux to redraw by re-sending current size
          sendResize();
        });
      });
    } else {
      xtermRef.current.blur();
    }
  }, [visible, doFit, sendResize]);

  const handleDisableMouse = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('DISABLE_MOUSE:');
    }
  }, []);

  const handleFixBell = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('FIX_BELL:');
    }
  }, []);

  const sendToWs = useCallback((data: string) => {
    const ws = wsRef.current;
    console.log('[sendToWs]', JSON.stringify(data), 'charCodes', [...data].map(c => c.charCodeAt(0)), 'wsOpen', ws?.readyState === WebSocket.OPEN);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  // Shared helper: apply active Ctrl/Shift/Alt modifiers to data, clear modifier state.
  // Uses refs for synchronous reads so it works reliably from any event handler.
  const applyModifiers = useCallback((data: string): string => {
    const ctrl = ctrlRef.current;
    const shift = shiftRef.current;
    const alt = altRef.current;
    console.log('[applyModifiers] called', { data: JSON.stringify(data), ctrl, shift, alt });
    if (!ctrl && !shift && !alt) return data;

    let modifiedData = data;
    // CSI escape sequence like \x1b[A, \x1b[B, etc.
    // eslint-disable-next-line no-control-regex -- matching CSI escape sequences requires \x1b
    const csiMatch = data.match(/^\x1b\[([A-D]|[0-9]+~)$/);
    if (csiMatch) {
      const modParam = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
      if (csiMatch[1].length === 1) {
        modifiedData = `\x1b[1;${modParam}${csiMatch[1]}`;
      } else {
        const code = csiMatch[1].slice(0, -1);
        modifiedData = `\x1b[${code};${modParam}~`;
      }
    } else if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
      // Single printable character
      let ch = data;
      if (shift) ch = ch.toUpperCase();
      if (alt) ch = `\x1b${ch}`;
      if (ctrl) {
        const code = ch.charCodeAt(ch.length - 1) & 0x1f;
        modifiedData = alt ? `\x1b${String.fromCharCode(code)}` : String.fromCharCode(code);
      } else {
        modifiedData = ch;
      }
    }
    // Clear modifiers after use (update both refs and state)
    ctrlRef.current = false;
    shiftRef.current = false;
    altRef.current = false;
    setCtrlActive(false);
    setShiftActive(false);
    setAltActive(false);
    console.log('[applyModifiers] result', JSON.stringify(modifiedData), 'charCodes', [...modifiedData].map(c => c.charCodeAt(0)));
    return modifiedData;
  }, []);

  const sendVirtualKey = useCallback((data: string, isScroll?: 'up' | 'down') => {
    const modifiedData = applyModifiers(data);

    if (isScroll && inScrollModeRef.current.current) {
      sendToWs(`SCROLL:${isScroll}:1:line`);
    } else {
      sendToWs(modifiedData);
    }
    // Restore focus to whatever had it (text input or terminal)
    const active = document.activeElement;
    requestAnimationFrame(() => {
      if (active instanceof HTMLElement) {
        active.focus();
      } else {
        xtermRef.current?.focus();
      }
    });
  }, [sendToWs, applyModifiers]);

  const handlePasteButton = useCallback(async () => {
    // Try Clipboard API first (works on desktop, may fail on iOS Safari)
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        xtermRef.current?.paste(text);
        return;
      }
    } catch { /* clipboard permission denied — fall through */ }
    // Fallback: use stored OSC 52 text if available
    if (osc52TextRef.current) {
      xtermRef.current?.paste(osc52TextRef.current);
      return;
    }
    // Last resort: show an input field where the user can native-paste
    setShowPasteInput(true);
    setTimeout(() => pasteInputRef.current?.focus(), 50);
  }, []);

  // Wrapper: absolute-positioned flex column; terminal fills remaining space
  return (
    <div ref={wrapperRef} className="absolute inset-1 overflow-hidden flex flex-col">
      <div ref={termRef} className="flex-1 min-h-0" />
      {mouseWarning && (
        <div
          className="absolute top-2 left-2 right-2 flex items-center gap-2 px-3 py-2 rounded z-20 text-sm"
          style={{
            background: 'rgba(180, 83, 9, 0.85)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <span className="text-amber-100 flex-1">
            Tmux mouse mode is on — text selection and copy won't work.
          </span>
          <button
            onClick={handleDisableMouse}
            className="px-2 py-0.5 rounded text-xs font-medium bg-amber-200 text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
          >
            Disable mouse mode
          </button>
          <button
            onClick={() => setMouseWarning(false)}
            className="text-amber-300 hover:text-amber-100 transition-colors shrink-0 text-lg leading-none"
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
      {bellWarning && (
        <div
          className="absolute left-2 right-2 flex items-center gap-2 px-3 py-2 rounded z-20 text-sm"
          style={{
            top: mouseWarning ? '3rem' : '0.5rem',
            background: 'rgba(180, 83, 9, 0.85)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <span className="text-amber-100 flex-1">
            Tmux bell notifications are disabled
            {bellWarning.bellAction ? ' — bell-action is set to none' : ''}
            {bellWarning.visualBell ? ' — visual-bell is enabled' : ''}.
          </span>
          <button
            onClick={handleFixBell}
            className="px-2 py-0.5 rounded text-xs font-medium bg-amber-200 text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
          >
            Fix bell settings
          </button>
          <button
            onClick={() => setBellWarning(null)}
            className="text-amber-300 hover:text-amber-100 transition-colors shrink-0 text-lg leading-none"
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
      {isDragging && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
          style={{
            background: 'rgba(59, 130, 246, 0.15)',
            border: '2px dashed rgba(59, 130, 246, 0.6)',
            borderRadius: '8px',
          }}
        >
          <span className="text-blue-400 text-lg font-medium">Drop image here</span>
        </div>
      )}
      {/* Virtual key toolbar for touch devices */}
      {IS_TOUCH_DEVICE && (
        showVirtualKeys ? (
          <div className={`shrink-0 z-20 backdrop-blur-sm border-t ${selectMode ? 'bg-blue-950/90 border-blue-500/50' : 'bg-gray-900/90 border-gray-700/50'}`}>
            {showTextInput && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-700/50">
                <input
                  ref={textInputRef}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="on"
                  spellCheck={false}
                  placeholder="Type here (slide/autocomplete)..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 font-mono outline-none focus:border-blue-500"
                  onCompositionStart={() => { console.log('[compositionStart]'); composingRef.current = true; }}
                  onCompositionEnd={(e) => {
                    composingRef.current = false;
                    // Send the composed text (autocomplete/slide result), applying modifiers if active
                    const composed = (e.target as HTMLInputElement).value.slice(prevInputRef.current.length);
                    console.log('[compositionEnd]', { composed: JSON.stringify(composed), ctrlRef: ctrlRef.current });
                    if (composed) {
                      if (ctrlRef.current || shiftRef.current || altRef.current) {
                        for (const ch of composed) {
                          sendToWs(applyModifiers(ch));
                        }
                      } else {
                        sendToWs(composed);
                      }
                    }
                    prevInputRef.current = (e.target as HTMLInputElement).value;
                  }}
                  onInput={(e) => {
                    console.log('[onInput]', { composing: composingRef.current, value: (e.target as HTMLInputElement).value, prev: prevInputRef.current, ctrlRef: ctrlRef.current });
                    if (composingRef.current) return; // wait for compositionEnd
                    const el = e.target as HTMLInputElement;
                    const newVal = el.value;
                    const oldVal = prevInputRef.current;
                    if (newVal.length > oldVal.length) {
                      // Characters added — apply modifiers (via refs) then send
                      const added = newVal.slice(oldVal.length);
                      if (ctrlRef.current || shiftRef.current || altRef.current) {
                        for (const ch of added) {
                          sendToWs(applyModifiers(ch));
                        }
                      } else {
                        sendToWs(added);
                      }
                    } else if (newVal.length < oldVal.length) {
                      // Characters deleted — send backspaces
                      const deleted = oldVal.length - newVal.length;
                      for (let i = 0; i < deleted; i++) sendToWs('\x7f');
                    }
                    prevInputRef.current = newVal;
                  }}
                  onKeyDown={(e) => {
                    console.log('[onKeyDown]', { key: e.key, keyCode: e.keyCode, ctrlRef: ctrlRef.current, shiftRef: shiftRef.current, altRef: altRef.current });
                    // When a modifier is active, intercept the keypress BEFORE it enters the input
                    if ((ctrlRef.current || shiftRef.current || altRef.current) && e.key.length === 1) {
                      e.preventDefault();
                      console.log('[onKeyDown] intercepted, sending modified key');
                      sendToWs(applyModifiers(e.key));
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      sendToWs(applyModifiers('\r'));
                      if (textInputRef.current) textInputRef.current.value = '';
                      prevInputRef.current = '';
                    }
                  }}
                />
              </div>
            )}
            <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
            {[
              { label: 'Esc', data: '\x1b' },
              { label: 'Tab', data: '\t' },
              { label: 'S-Tab', data: '\x1b[Z' },
              { label: '^C', data: '\x03', className: 'text-red-400' },
            ].map(({ label, data, className }) => (
              <button
                key={label}
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.preventDefault()}
                onClick={() => sendVirtualKey(data)}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors shrink-0 ${className || 'text-gray-200'}`}
              >
                {label}
              </button>
            ))}
            {[
              { label: 'Ctrl', active: ctrlActive, toggle: setCtrlActive },
              { label: 'Shift', active: shiftActive, toggle: setShiftActive },
              { label: 'Alt', active: altActive, toggle: setAltActive },
            ].map(({ label, active, toggle }) => (
              <button
                key={label}
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.preventDefault()}
                onClick={() => { console.log(`[modifier] ${label} toggled, was:`, active, 'refs:', { ctrl: ctrlRef.current, shift: shiftRef.current, alt: altRef.current }); toggle(v => !v); }}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors shrink-0 ${active ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-gray-200'}`}
              >
                {label}
              </button>
            ))}
            <div className="w-px h-5 bg-gray-700 mx-0.5 shrink-0" />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[D')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200 shrink-0"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[B', 'down')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200 shrink-0"
            >
              <ChevronDown size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[A', 'up')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200 shrink-0"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[C')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200 shrink-0"
            >
              <ChevronRight size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('|')}
              className="px-2.5 py-1 rounded text-xs font-mono font-medium bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200 shrink-0"
            >
              |
            </button>
            <div className="flex-1" />
            {/* Clipboard & select mode — right side */}
            {showPasteInput ? (
              <input
                ref={pasteInputRef}
                type="text"
                autoComplete="off"
                placeholder="Long-press to paste here"
                className="w-40 bg-gray-800 border border-blue-500 rounded px-2 py-1 text-xs text-gray-200 font-mono outline-none shrink-0"
                onPaste={(e) => {
                  e.preventDefault();
                  const text = e.clipboardData.getData('text/plain');
                  if (text) xtermRef.current?.paste(text);
                  setShowPasteInput(false);
                  xtermRef.current?.focus();
                }}
                onBlur={() => setShowPasteInput(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setShowPasteInput(false);
                    xtermRef.current?.focus();
                  }
                }}
              />
            ) : (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.preventDefault()}
                onClick={handlePasteButton}
                className="px-2.5 py-1 rounded text-xs font-medium bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200 flex items-center gap-1 shrink-0"
                title="Paste from clipboard"
              >
                <ClipboardPaste size={12} /> Paste
              </button>
            )}
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => {
                if (selectMode) {
                  xtermRef.current?.clearSelection();
                  selectionTextRef.current = '';
                  setSelectMode(false);
                  setHasSelection(false);
                  setCopyFeedback(null);
                } else {
                  setSelectMode(true);
                }
              }}
              className={`px-1.5 py-1 rounded transition-colors shrink-0 ${selectMode ? 'text-blue-400 bg-blue-900/30' : 'text-gray-400 hover:text-gray-200'}`}
              title={selectMode ? 'Exit select mode' : 'Select text'}
            >
              <MousePointer2 size={14} />
            </button>
            {selectMode && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={async () => {
                  const sel = selectionTextRef.current || xtermRef.current?.getSelection() || '';
                  if (!sel) {
                    setCopyFeedback('No text');
                    setTimeout(() => setCopyFeedback(null), 3000);
                    return;
                  }
                  const result = await copyToClipboard(sel);
                  setCopyFeedback(`${result} (${sel.length}ch)`);
                  xtermRef.current?.clearSelection();
                  selectionTextRef.current = '';
                  setHasSelection(false);
                  setTimeout(() => {
                    setCopyFeedback(null);
                    setSelectMode(false);
                  }, 3000);
                }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1 shrink-0 ${
                  hasSelection
                    ? 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white'
                    : copyFeedback
                      ? 'bg-green-700 text-white'
                      : 'bg-gray-700 text-gray-500'
                }`}
              >
                <Copy size={12} /> {copyFeedback || 'Copy'}
              </button>
            )}
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => {
                setShowTextInput(v => !v);
                if (!showTextInput) setTimeout(() => textInputRef.current?.focus(), 50);
              }}
              className={`px-1.5 py-1 rounded transition-colors ${showTextInput ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
              title="Text input"
            >
              <Type size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => { setShowVirtualKeys(false); setShowTextInput(false); doFit(); }}
              className="px-1.5 py-1 rounded text-gray-500 hover:text-gray-300 transition-colors"
              title="Hide virtual keys"
            >
              <Keyboard size={14} />
            </button>
            </div>
          </div>
        ) : (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={() => { setShowVirtualKeys(true); doFit(); }}
            className="absolute bottom-1 right-1 z-20 p-1.5 rounded bg-gray-800/80 text-gray-500 hover:text-gray-300 transition-colors"
            title="Show virtual keys"
          >
            <Keyboard size={14} />
          </button>
        )
      )}
    </div>
  );
});
