import type { ApiClient } from '../api/client';
import type {
  Container,
  ContainerListResponse,
  Template,
  Settings,
  CreateContainerRequest,
  CreateSessionRequest,
  CreateWindowRequest,
  TmuxSession,
  TmuxWindow,
} from '../types';
import { mockContainers, mockTemplates, mockSettings } from './mockData';

const delay = (ms?: number) =>
  new Promise((resolve) => setTimeout(resolve, ms ?? 200 + Math.random() * 300));

// Deep clone to simulate server-side state
let containers: Container[] = JSON.parse(JSON.stringify(mockContainers));
let templates: Template[] = JSON.parse(JSON.stringify(mockTemplates));
const settings: Settings = JSON.parse(JSON.stringify(mockSettings));

let nextContainerId = 100;
let nextTemplateId = 100;
let nextSessionId = 100;

export const mockApi: ApiClient = {
  // Containers
  async listContainers(): Promise<ContainerListResponse> {
    await delay();
    return { containers: JSON.parse(JSON.stringify(containers)) };
  },

  async createContainer(req: CreateContainerRequest) {
    await delay(500);
    const template = templates.find((t) => t.id === req.templateId);
    const id = `mock-${nextContainerId++}`;
    const container: Container = {
      id,
      name: `tmuxdeck-${req.name}`,
      displayName: req.name,
      status: 'running',
      image: template ? `${template.name}:latest` : 'unknown:latest',
      templateId: req.templateId,
      sessions: [{ id: `s${nextSessionId++}`, name: 'main', windows: [{ index: 0, name: 'bash', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' }], created: new Date().toISOString(), attached: false }],
      createdAt: new Date().toISOString(),
    };
    containers.push(container);
    return JSON.parse(JSON.stringify(container));
  },

  async getContainer(id: string) {
    await delay();
    const c = containers.find((c) => c.id === id);
    if (!c) throw new Error(`Container ${id} not found`);
    return JSON.parse(JSON.stringify(c));
  },

  async renameContainer(id: string, displayName: string) {
    if (id === 'host' || id === 'local') throw new Error('Cannot rename a special container');
    await delay();
    const c = containers.find((c) => c.id === id);
    if (!c) throw new Error(`Container ${id} not found`);
    c.displayName = displayName;
    c.name = `tmuxdeck-${displayName}`;
    return JSON.parse(JSON.stringify(c));
  },

  async startContainer(id: string) {
    if (id === 'host' || id === 'local') return;
    await delay(400);
    const c = containers.find((c) => c.id === id);
    if (!c) throw new Error(`Container ${id} not found`);
    c.status = 'running';
  },

  async stopContainer(id: string) {
    if (id === 'host' || id === 'local') return;
    await delay(400);
    const c = containers.find((c) => c.id === id);
    if (!c) throw new Error(`Container ${id} not found`);
    c.status = 'stopped';
  },

  async removeContainer(id: string) {
    if (id === 'host' || id === 'local') throw new Error('Cannot remove a special container');
    await delay(300);
    containers = containers.filter((c) => c.id !== id);
  },

  // Sessions
  async listSessions(containerId: string) {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    return JSON.parse(JSON.stringify(c.sessions));
  },

  async createSession(containerId: string, req: CreateSessionRequest) {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    const session: TmuxSession = {
      id: `s${nextSessionId++}`,
      name: req.name,
      windows: [{ index: 0, name: 'bash', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' }],
      created: new Date().toISOString(),
      attached: false,
    };
    c.sessions.push(session);
    return JSON.parse(JSON.stringify(session));
  },

  async renameSession(containerId: string, sessionId: string, newName: string) {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    const s = c.sessions.find((s) => s.id === sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    s.name = newName;
  },

  async killSession(containerId: string, sessionId: string) {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    c.sessions = c.sessions.filter((s) => s.id !== sessionId);
  },

  async swapWindows(containerId: string, sessionId: string, index1: number, index2: number) {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    const s = c.sessions.find((s) => s.id === sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    const w1 = s.windows.find((w) => w.index === index1);
    const w2 = s.windows.find((w) => w.index === index2);
    if (w1 && w2) {
      w1.index = index2;
      w2.index = index1;
    }
  },

  async createWindow(containerId: string, sessionId: string, req: CreateWindowRequest): Promise<TmuxWindow[]> {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    const s = c.sessions.find((s) => s.id === sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    const nextIndex = s.windows.length > 0 ? Math.max(...s.windows.map((w) => w.index)) + 1 : 0;
    const win: TmuxWindow = {
      index: nextIndex,
      name: req.name || 'bash',
      active: false,
      panes: 1,
      bell: false,
      activity: false,
      command: 'bash',
      paneStatus: '',
    };
    s.windows.push(win);
    return JSON.parse(JSON.stringify(s.windows));
  },

  async moveWindow(containerId: string, sessionId: string, windowIndex: number, targetSessionId: string) {
    await delay();
    const c = containers.find((c) => c.id === containerId);
    if (!c) throw new Error(`Container ${containerId} not found`);
    const src = c.sessions.find((s) => s.id === sessionId);
    const dst = c.sessions.find((s) => s.id === targetSessionId);
    if (!src || !dst) throw new Error('Session not found');
    const wIdx = src.windows.findIndex((w) => w.index === windowIndex);
    if (wIdx !== -1) {
      const [win] = src.windows.splice(wIdx, 1);
      win.index = dst.windows.length > 0 ? Math.max(...dst.windows.map((w) => w.index)) + 1 : 0;
      dst.windows.push(win);
    }
  },

  // Templates
  async listTemplates() {
    await delay();
    return JSON.parse(JSON.stringify(templates));
  },

  async createTemplate(template) {
    await delay();
    const t: Template = {
      ...template,
      id: `t${nextTemplateId++}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    templates.push(t);
    return JSON.parse(JSON.stringify(t));
  },

  async getTemplate(id: string) {
    await delay();
    const t = templates.find((t) => t.id === id);
    if (!t) throw new Error(`Template ${id} not found`);
    return JSON.parse(JSON.stringify(t));
  },

  async updateTemplate(id: string, update: Partial<Template>) {
    await delay();
    const t = templates.find((t) => t.id === id);
    if (!t) throw new Error(`Template ${id} not found`);
    Object.assign(t, update, { updatedAt: new Date().toISOString() });
    return JSON.parse(JSON.stringify(t));
  },

  async deleteTemplate(id: string) {
    await delay();
    templates = templates.filter((t) => t.id !== id);
  },

  // Settings
  async getSettings() {
    await delay();
    return JSON.parse(JSON.stringify(settings));
  },

  async updateSettings(update: Partial<Settings>) {
    await delay();
    Object.assign(settings, update);
    return JSON.parse(JSON.stringify(settings));
  },

  async getTelegramChats() {
    await delay();
    return { chats: [] as { chatId: number; username: string | null; firstName: string | null }[] };
  },

  async removeTelegramChat(_chatId: number) {
    await delay();
    return { chats: [] as { chatId: number; username: string | null; firstName: string | null }[] };
  },
};
