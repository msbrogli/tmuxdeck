import type {
  Container,
  Template,
  Settings,
  CreateContainerRequest,
  CreateSessionRequest,
  CreateWindowRequest,
  TmuxSession,
  TmuxWindow,
} from '../types';

export interface ApiClient {
  // Containers
  listContainers(): Promise<Container[]>;
  createContainer(req: CreateContainerRequest): Promise<Container>;
  getContainer(id: string): Promise<Container>;
  renameContainer(id: string, displayName: string): Promise<Container>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  removeContainer(id: string): Promise<void>;

  // Sessions
  listSessions(containerId: string): Promise<TmuxSession[]>;
  createSession(containerId: string, req: CreateSessionRequest): Promise<TmuxSession>;
  renameSession(containerId: string, sessionId: string, newName: string): Promise<void>;
  killSession(containerId: string, sessionId: string): Promise<void>;
  swapWindows(containerId: string, sessionId: string, index1: number, index2: number): Promise<void>;
  moveWindow(containerId: string, sessionId: string, windowIndex: number, targetSessionId: string): Promise<void>;
  createWindow(containerId: string, sessionId: string, req: CreateWindowRequest): Promise<TmuxWindow[]>;

  // Templates
  listTemplates(): Promise<Template[]>;
  createTemplate(template: Omit<Template, 'id' | 'createdAt' | 'updatedAt'>): Promise<Template>;
  getTemplate(id: string): Promise<Template>;
  updateTemplate(id: string, template: Partial<Template>): Promise<Template>;
  deleteTemplate(id: string): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
}

import { mockApi } from '../mocks/mockApi';
import { httpApi } from './httpClient';

export const api: ApiClient = import.meta.env.VITE_USE_MOCK === 'true' ? mockApi : httpApi;

export { createContainerStream } from './httpClient';
