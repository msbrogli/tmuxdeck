import type { ApiClient } from './client';
import type {
  AuthStatus,
  Container,
  ContainerListResponse,
  ContainerStreamEvent,
  Template,
  TelegramChat,
  Settings,
  CreateContainerRequest,
  CreateSessionRequest,
  CreateWindowRequest,
  TmuxSession,
  TmuxWindow,
} from '../types';

const BASE = '/api/v1';

// Module-level cached PIN for auto-re-auth after backend restart.
// Only lives in memory — lost on page refresh/tab close.
let cachedPin: string | null = null;
let reAuthPromise: Promise<boolean> | null = null;

export function setCachedPin(pin: string) {
  cachedPin = pin;
}

export function clearCachedPin() {
  cachedPin = null;
}

// Callback to trigger auth gate from outside React
let onAuthLost: (() => void) | null = null;
export function setOnAuthLost(cb: (() => void) | null) {
  onAuthLost = cb;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Attempt auto-re-auth with cached PIN
    const reAuthed = await attemptReAuth();
    if (reAuthed) {
      // Retry the original request
      const retryRes = await fetch(`${BASE}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      if (!retryRes.ok) {
        const text = await retryRes.text().catch(() => retryRes.statusText);
        throw new Error(text);
      }
      if (retryRes.status === 204) return undefined as T;
      return retryRes.json();
    }
    // Re-auth failed — trigger auth gate
    onAuthLost?.();
    throw new Error('Not authenticated');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function attemptReAuth(): Promise<boolean> {
  if (!cachedPin) return false;

  // Deduplicate concurrent re-auth attempts
  if (reAuthPromise) return reAuthPromise;

  reAuthPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: cachedPin }),
      });
      if (res.ok) return true;
      // PIN was changed — clear cache
      cachedPin = null;
      return false;
    } catch {
      return false;
    } finally {
      reAuthPromise = null;
    }
  })();

  return reAuthPromise;
}

// --- Auth API functions ---

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${BASE}/auth/status`);
  return res.json();
}

export async function loginWithPin(pin: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ detail: 'Login failed' }));
    throw new Error(data.detail || 'Login failed');
  }
  cachedPin = pin;
}

export async function setupPin(pin: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ detail: 'Setup failed' }));
    throw new Error(data.detail || 'Setup failed');
  }
  cachedPin = pin;
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: 'POST' });
  cachedPin = null;
}

export async function changePin(currentPin: string, newPin: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/change-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPin, newPin }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ detail: 'Change failed' }));
    throw new Error(data.detail || 'Change failed');
  }
  cachedPin = newPin;
}

export const httpApi: ApiClient = {
  // Containers
  listContainers: () => request<ContainerListResponse>('/containers'),
  createContainer: (req: CreateContainerRequest) =>
    request<Container>('/containers', { method: 'POST', body: JSON.stringify(req) }),
  getContainer: (id: string) => request<Container>(`/containers/${id}`),
  renameContainer: (id: string, displayName: string) =>
    request<Container>(`/containers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),
  startContainer: (id: string) =>
    request<void>(`/containers/${id}/start`, { method: 'POST' }),
  stopContainer: (id: string) =>
    request<void>(`/containers/${id}/stop`, { method: 'POST' }),
  removeContainer: (id: string) =>
    request<void>(`/containers/${id}`, { method: 'DELETE' }),

  // Sessions
  listSessions: (containerId: string) =>
    request<TmuxSession[]>(`/containers/${containerId}/sessions`),
  createSession: (containerId: string, req: CreateSessionRequest) =>
    request<TmuxSession>(`/containers/${containerId}/sessions`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  renameSession: (containerId: string, sessionId: string, newName: string) =>
    request<void>(`/containers/${containerId}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    }),
  killSession: (containerId: string, sessionId: string) =>
    request<void>(`/containers/${containerId}/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  swapWindows: (containerId: string, sessionId: string, index1: number, index2: number) =>
    request<void>(`/containers/${containerId}/sessions/${sessionId}/swap-windows`, {
      method: 'POST',
      body: JSON.stringify({ index1, index2 }),
    }),
  moveWindow: (containerId: string, sessionId: string, windowIndex: number, targetSessionId: string) =>
    request<void>(`/containers/${containerId}/sessions/${sessionId}/move-window`, {
      method: 'POST',
      body: JSON.stringify({ windowIndex, targetSessionId }),
    }),
  createWindow: (containerId: string, sessionId: string, req: CreateWindowRequest) =>
    request<TmuxWindow[]>(`/containers/${containerId}/sessions/${sessionId}/windows`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  // Templates
  listTemplates: () => request<Template[]>('/templates'),
  createTemplate: (template) =>
    request<Template>('/templates', { method: 'POST', body: JSON.stringify(template) }),
  getTemplate: (id: string) => request<Template>(`/templates/${id}`),
  updateTemplate: (id: string, update: Partial<Template>) =>
    request<Template>(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(update) }),
  deleteTemplate: (id: string) =>
    request<void>(`/templates/${id}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request<Settings>('/settings'),
  updateSettings: (update: Partial<Settings>) =>
    request<Settings>('/settings', { method: 'POST', body: JSON.stringify(update) }),

  // Telegram chats
  getTelegramChats: () => request<{ chats: TelegramChat[] }>('/settings/telegram-chats'),
  removeTelegramChat: (chatId: number) =>
    request<{ chats: TelegramChat[] }>(`/settings/telegram-chats/${chatId}`, { method: 'DELETE' }),
};

export async function createContainerStream(
  req: CreateContainerRequest,
  onEvent: (event: ContainerStreamEvent) => void,
): Promise<Container> {
  const res = await fetch(`${BASE}/containers/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: Container | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      const event: ContainerStreamEvent = JSON.parse(line);
      onEvent(event);

      if (event.event === 'complete') {
        result = event.container;
      } else if (event.event === 'error') {
        throw new Error(event.message);
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const event: ContainerStreamEvent = JSON.parse(buffer);
    onEvent(event);
    if (event.event === 'complete') {
      result = event.container;
    } else if (event.event === 'error') {
      throw new Error(event.message);
    }
  }

  if (!result) {
    throw new Error('Stream ended without a complete event');
  }
  return result;
}
