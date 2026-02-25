export type ContainerStatus = 'running' | 'stopped' | 'creating' | 'error';

export interface SessionTarget {
  containerId: string;
  sessionName: string;
  windowIndex: number;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: number;
  bell: boolean;
  activity: boolean;
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

export interface Settings {
  telegramBotToken: string;
  telegramAllowedUsers: string[];
  defaultVolumeMounts: string[];
  sshKeyPath: string;
  terminalPoolSize?: number;
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
