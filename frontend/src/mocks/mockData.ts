import type { Container, Template, Settings } from '../types';

export const mockContainers: Container[] = [
  {
    id: 'local',
    name: 'local',
    displayName: 'Local',
    status: 'running',
    image: 'local',
    containerType: 'local',
    sessions: [
      { id: 'sl1', name: 'main', windows: [{ index: 0, name: 'bash', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' }], created: '2026-02-24T07:00:00Z', attached: false },
    ],
    createdAt: '2026-02-24T00:00:00Z',
  },
  {
    id: 'host',
    name: 'localhost',
    displayName: 'Host',
    status: 'running',
    image: 'host',
    containerType: 'host',
    sessions: [
      { id: 'sh1', name: 'dev', windows: [
        { index: 0, name: 'vim', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' },
        { index: 1, name: 'npm', active: false, panes: 1, bell: true, activity: false, command: 'node', paneStatus: '' },
        { index: 2, name: 'git', active: false, panes: 1, bell: false, activity: true, command: 'bash', paneStatus: '' },
      ], created: '2026-02-24T08:00:00Z', attached: false, summary: 'vim src/main.ts | npm run dev | git log' },
      { id: 'sh2', name: 'monitoring', windows: [{ index: 0, name: 'htop', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' }], created: '2026-02-24T08:30:00Z', attached: false, summary: 'htop' },
    ],
    createdAt: '2026-02-24T00:00:00Z',
  },
  {
    id: 'c1a2b3c4d5e6',
    name: 'tmuxdeck-my-project',
    displayName: 'my-project',
    status: 'running',
    image: 'claude-worker:latest',
    templateId: 't1',
    sessions: [
      { id: 's1', name: 'claude', windows: [{ index: 0, name: 'claude', active: true, panes: 1, bell: true, activity: true, command: 'node', paneStatus: 'running' }], created: '2026-02-24T10:00:00Z', attached: false, summary: 'claude --chat' },
      { id: 's2', name: 'shell', windows: [
        { index: 0, name: 'npm', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' },
        { index: 1, name: 'vim', active: false, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' },
      ], created: '2026-02-24T10:05:00Z', attached: false, summary: 'npm test | vim README.md' },
    ],
    createdAt: '2026-02-24T09:00:00Z',
  },
  {
    id: 'd7e8f9a0b1c2',
    name: 'tmuxdeck-api-server',
    displayName: 'api-server',
    status: 'running',
    image: 'claude-worker:latest',
    templateId: 't1',
    sessions: [
      { id: 's3', name: 'claude', windows: [{ index: 0, name: 'claude', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' }], created: '2026-02-24T11:00:00Z', attached: false, summary: 'claude --chat' },
    ],
    createdAt: '2026-02-24T10:30:00Z',
  },
  {
    id: 'e3f4a5b6c7d8',
    name: 'tmuxdeck-old-project',
    displayName: 'old-project',
    status: 'stopped',
    image: 'python-dev:latest',
    templateId: 't2',
    sessions: [
      { id: 's4', name: 'main', windows: [{ index: 0, name: 'python', active: true, panes: 1, bell: false, activity: false, command: 'bash', paneStatus: '' }], created: '2026-02-20T08:00:00Z', attached: false, summary: 'python train.py' },
    ],
    createdAt: '2026-02-20T08:00:00Z',
  },
];

export const mockTemplates: Template[] = [
  {
    id: 't1',
    name: 'claude-worker',
    type: 'dockerfile',
    content: `FROM node:20-bookworm

RUN apt-get update && apt-get install -y \\
    git tmux curl wget \\
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

CMD ["tmux", "new-session", "-s", "claude"]
`,
    buildArgs: {},
    defaultVolumes: ['/home/user/.claude:/root/.claude', '/home/user/projects:/workspace'],
    defaultEnv: { ANTHROPIC_API_KEY: '' },
    createdAt: '2026-02-20T00:00:00Z',
    updatedAt: '2026-02-20T00:00:00Z',
  },
  {
    id: 't2',
    name: 'python-dev',
    type: 'dockerfile',
    content: `FROM python:3.12-bookworm

RUN apt-get update && apt-get install -y \\
    git tmux curl wget vim \\
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir ipython

WORKDIR /workspace

CMD ["tmux", "new-session", "-s", "main"]
`,
    buildArgs: {},
    defaultVolumes: ['/home/user/projects:/workspace'],
    defaultEnv: {},
    createdAt: '2026-02-20T00:00:00Z',
    updatedAt: '2026-02-20T00:00:00Z',
  },
  {
    id: 't3',
    name: 'basic-dev',
    type: 'dockerfile',
    content: `FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \\
    git tmux curl wget build-essential \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["tmux", "new-session", "-s", "main"]
`,
    buildArgs: {},
    defaultVolumes: [],
    defaultEnv: {},
    createdAt: '2026-02-21T00:00:00Z',
    updatedAt: '2026-02-21T00:00:00Z',
  },
];

export const mockSettings: Settings = {
  telegramBotToken: '',
  telegramAllowedUsers: [],
  defaultVolumeMounts: ['/home/user/.claude:/root/.claude'],
  sshKeyPath: '~/.ssh/id_rsa',
};
