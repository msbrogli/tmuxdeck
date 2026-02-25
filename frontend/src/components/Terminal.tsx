import { useEffect, useRef, useImperativeHandle, useCallback, forwardRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface TerminalHandle {
  focus: () => void;
  refit: () => void;
}

interface TerminalProps {
  containerId: string;
  sessionName: string;
  windowIndex: number;
  autoFocus?: boolean;
  visible?: boolean;
}

const IS_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

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

function setupWebSocketTerminal(
  term: XTerm,
  fitAddon: FitAddon,
  containerId: string,
  sessionName: string,
  windowIndex: number,
  onMouseWarning: (enabled: boolean) => void,
): { cleanup: () => void; ws: WebSocket; inScrollMode: { current: boolean } } {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${containerId}/${sessionName}/${windowIndex}`;
  const ws = new WebSocket(wsUrl);

  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // Don't send RESIZE immediately — proposeDimensions() returns
    // defaults (80×25) before fitAddon.fit() has measured the DOM.
    // Defer so the initial fit cycle (also double-rAF deferred, but
    // scheduled earlier) runs first, then send correct dimensions.
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
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else {
      const text = event.data as string;
      // Intercept backend control messages
      if (text.startsWith('MOUSE_WARNING:')) {
        onMouseWarning(text === 'MOUSE_WARNING:on');
        return;
      }
      term.write(text);
    }
  };

  ws.onclose = () => {
    term.writeln('\r\n\x1b[1;31m[Connection closed]\x1b[0m');
  };

  ws.onerror = () => {
    term.writeln('\r\n\x1b[1;31m[WebSocket error]\x1b[0m');
  };

  // Send terminal input to backend
  const dataDisposable = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Send binary input to backend
  const binaryDisposable = term.onBinary((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      const buffer = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        buffer[i] = data.charCodeAt(i) & 0xff;
      }
      ws.send(buffer);
    }
  });

  // Send resize events
  const resizeDisposable = term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`RESIZE:${cols}:${rows}`);
    }
  });

  // Scroll state: tracks whether tmux is in copy-mode
  const inScrollMode = { current: false };

  // Exit scroll mode when the user types any key
  const scrollExitDisposable = term.onData(() => {
    if (inScrollMode.current) {
      inScrollMode.current = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('SCROLL:exit');
      }
    }
  });

  // Intercept Shift+Enter and copy/paste shortcuts
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;

    // Shift+Enter → CSI u escape sequence
    if (e.key === 'Enter' && e.shiftKey) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('\x1b[13;2u');
      }
      return false;
    }

    // Copy: Ctrl+Shift+C (Linux/Windows) or Cmd+C (Mac)
    if (e.key === 'c' || e.key === 'C') {
      const shouldCopy = isMac ? (e.metaKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey);
      if (shouldCopy && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
    }

    // Paste: Ctrl+Shift+V (Linux/Windows) or Cmd+V (Mac)
    if (e.key === 'v' || e.key === 'V') {
      const shouldPaste = isMac ? (e.metaKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey);
      if (shouldPaste) {
        navigator.clipboard.readText().then((text) => {
          if (text && ws.readyState === WebSocket.OPEN) {
            ws.send(text);
          }
        });
        return false;
      }
    }

    // PageUp / PageDown: scroll tmux by a full page
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      if (ws.readyState === WebSocket.OPEN) {
        const pageLines = term.rows;
        if (e.key === 'PageUp') {
          inScrollMode.current = true;
          ws.send(`SCROLL:up:${pageLines}`);
        } else {
          ws.send(`SCROLL:down:${pageLines}`);
        }
      }
      return false;
    }

    return true;
  });

  const cleanup = () => {
    dataDisposable.dispose();
    binaryDisposable.dispose();
    resizeDisposable.dispose();
    scrollExitDisposable.dispose();
    ws.close();
  };

  return { cleanup, ws, inScrollMode };
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

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ containerId, sessionName, windowIndex, autoFocus = true, visible = true }, ref) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSentDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const windowIndexRef = useRef(windowIndex);
  const inScrollModeRef = useRef<{ current: boolean }>({ current: false });
  const [isDragging, setIsDragging] = useState(false);
  const [mouseWarning, setMouseWarning] = useState(false);

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
      const wrapper = wrapperRef.current;
      const container = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!wrapper || !container || !fitAddon) return;
      const { width, height } = wrapper.getBoundingClientRect();
      if (width > 0 && height > 0) {
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
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
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Measure wrapper and set explicit pixel dimensions, then fit
    const fitAndResize = (retries = 3) => {
      const { width, height } = wrapper.getBoundingClientRect();
      if (width > 0 && height > 0) {
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
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
      const { cleanup, ws, inScrollMode } = setupWebSocketTerminal(term, fitAddon, containerId, sessionName, windowIndexRef.current, setMouseWarning);
      wsRef.current = ws;
      inScrollModeRef.current = inScrollMode;
      // Store cleanup for unmount
      (wrapper as unknown as Record<string, () => void>).__wsCleanup = cleanup;
    }

    // Observe the wrapper (which has guaranteed dimensions via absolute positioning)
    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(wrapper);

    // --- Paste handler: intercept image pastes ---
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
        ws.send(`SCROLL:up:${lines}`);
      } else {
        // Scroll down
        ws.send(`SCROLL:down:${lines}`);
      }
    };

    wrapper.addEventListener('paste', handlePaste, { capture: true });
    wrapper.addEventListener('dragover', handleDragOver);
    wrapper.addEventListener('dragleave', handleDragLeave);
    wrapper.addEventListener('drop', handleDrop);
    wrapper.addEventListener('wheel', handleWheel, { capture: true, passive: false });

    return () => {
      cancelAnimationFrame(rafId);
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
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- windowIndex changes are
  // handled by the SELECT_WINDOW effect below; including it here would tear down the
  // WebSocket connection instead of smoothly switching windows.
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

  // Wrapper: absolute-positioned to get guaranteed dimensions from parent
  // Container: sized explicitly in pixels by doFit()
  return (
    <div ref={wrapperRef} className="absolute inset-1 overflow-hidden">
      <div ref={termRef} />
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
    </div>
  );
});
