export type ContainerStatus = 'running' | 'stopped' | 'creating' | 'error';

export interface SessionTarget {
  containerId: string;
  sessionName: string;
  windowIndex: number;
}

export interface FoldedSessionTarget {
  containerId: string;
  sessionName: string;
  sessionId: string;
  folded: true;
}

export type Selection = SessionTarget | FoldedSessionTarget;

export function isWindowSelection(s: Selection): s is SessionTarget {
  return !('folded' in s);
}

export function isFoldedSelection(s: Selection): s is FoldedSessionTarget {
  return 'folded' in s && s.folded === true;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: number;
  bell: boolean;
  activity: boolean;
  command?: string;
  paneStatus?: string;
}

export interface TmuxSession {
  id: string;
  name: string;
  windows: TmuxWindow[];
  created: string;
  attached: boolean;
  summary?: string;
}

export interface Container {
  id: string;
  name: string;
  displayName: string;
  status: ContainerStatus;
  image: string;
  isHost?: boolean;
  isLocal?: boolean;
  templateId?: string;
  sessions: TmuxSession[];
  createdAt: string;
}

export interface ContainerListResponse {
  containers: Container[];
  dockerError?: string;
}

export interface Template {
  id: string;
  name: string;
  type: 'dockerfile' | 'compose';
  content: string;
  buildArgs: Record<string, string>;
  defaultVolumes: string[];
  defaultEnv: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramLink {
  id: string;
  chatId: number;
  dockerContainerId: string;
  tmuxSession: string;
  isActive: boolean;
  createdAt: string;
}

export interface TelegramChat {
  chatId: number;
  username: string | null;
  firstName: string | null;
}

export interface Settings {
  telegramBotToken: string;
  telegramAllowedUsers: string[];
  defaultVolumeMounts: string[];
  sshKeyPath: string;
  terminalPoolSize?: number;
  telegramRegistrationSecret?: string;
  telegramNotificationTimeoutSecs?: number;
  hotkeys?: Record<string, string>;
}

export interface ClaudeNotification {
  id: string;
  message: string;
  title: string;
  notificationType: string;
  sessionId: string;
  containerId: string;
  tmuxSession: string;
  tmuxWindow: number;
  createdAt: string;
  status: string;
  channels?: string[];
}

export interface CreateContainerRequest {
  templateId: string;
  name: string;
  env: Record<string, string>;
  volumes: string[];
  mountSsh: boolean;
  mountClaude: boolean;
}

export type ContainerStreamEvent =
  | { event: 'step'; step: string; message: string }
  | { event: 'log'; line: string }
  | { event: 'complete'; container: Container }
  | { event: 'error'; step?: string; message: string };

export interface AuthStatus {
  authenticated: boolean;
  pinSet: boolean;
}

export interface CreateSessionRequest {
  name: string;
}

export interface CreateWindowRequest {
  name?: string;
}
