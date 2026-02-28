import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Copy, Check, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';
import type { BridgeConfig } from '../types';

export function BridgeSettingsPage() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [createdBridge, setCreatedBridge] = useState<BridgeConfig | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [deletingBridge, setDeletingBridge] = useState<BridgeConfig | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  const { data: bridges = [], error } = useQuery({
    queryKey: ['bridges'],
    queryFn: () => api.listBridges(),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => api.createBridge(name),
    onSuccess: (bridge) => {
      setCreatedBridge(bridge);
      setNewName('');
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateBridge(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteBridge(id),
    onSuccess: () => {
      setDeletingBridge(null);
      setDeleteConfirmName('');
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const copyToken = (token: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(token).catch(() => fallbackCopy(token));
    } else {
      fallbackCopy(token);
    }
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreatedBridge(null);
    createMutation.mutate(name);
  };

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-gray-100 mb-8">Bridges</h1>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            Failed to load bridges: {error.message}
          </div>
        )}

        {/* Create form */}
        <form onSubmit={handleCreate} className="flex items-center gap-2 mb-6">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Bridge name"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={!newName.trim() || createMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={14} />
            Create
          </button>
        </form>

        {createMutation.isError && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            {createMutation.error.message}
          </div>
        )}

        {/* Token display (shown once on creation) */}
        {createdBridge?.token && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-yellow-900/20 border border-yellow-800/50">
            <p className="text-sm text-yellow-300 mb-2">
              Bridge token for <span className="font-medium">{createdBridge.name}</span> — copy it now, it won't be shown again:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-gray-900 rounded px-3 py-2 text-sm text-gray-200 font-mono break-all select-all">
                {createdBridge.token}
              </code>
              <button
                onClick={() => copyToken(createdBridge.token!)}
                className="flex items-center gap-1 px-2.5 py-2 rounded-md text-xs text-gray-400 hover:text-gray-200 transition-colors"
                title="Copy token"
              >
                {tokenCopied ? (
                  <>
                    <Check size={14} className="text-green-400" />
                    <span className="text-green-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={14} />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Bridge list */}
        <div>
          <label className="block text-sm text-gray-400 mb-2">Configured Bridges</label>
          {bridges.length === 0 ? (
            <p className="text-xs text-gray-600">
              No bridges configured yet. Create one above to connect a remote agent.
            </p>
          ) : (
            <div className="space-y-1">
              {bridges.map((bridge) => (
                <div
                  key={bridge.id}
                  className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        !bridge.enabled ? 'bg-gray-600' : bridge.connected ? 'bg-green-500' : 'bg-gray-600'
                      }`}
                      title={!bridge.enabled ? 'Disabled' : bridge.connected ? 'Online' : 'Offline'}
                    />
                    <span className={`text-sm ${bridge.enabled ? 'text-gray-200' : 'text-gray-500'}`}>
                      {bridge.name}
                    </span>
                    <span className={`text-xs ${
                      !bridge.enabled ? 'text-gray-600' : bridge.connected ? 'text-green-400' : 'text-gray-500'
                    }`}>
                      {!bridge.enabled ? 'Disabled' : bridge.connected ? 'Online' : 'Offline'}
                    </span>
                    <span className="text-xs text-gray-600">
                      {new Date(bridge.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleMutation.mutate({ id: bridge.id, enabled: !bridge.enabled })}
                      disabled={toggleMutation.isPending}
                      className={`p-1 transition-colors ${
                        bridge.enabled
                          ? 'text-green-400 hover:text-green-300'
                          : 'text-gray-600 hover:text-gray-400'
                      }`}
                      title={bridge.enabled ? 'Disable bridge' : 'Enable bridge'}
                    >
                      {bridge.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                    </button>
                    <button
                      onClick={() => {
                        setDeletingBridge(bridge);
                        setDeleteConfirmName('');
                        deleteMutation.reset();
                      }}
                      className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                      title="Delete bridge"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deletingBridge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">Delete Bridge</h2>
            <p className="text-sm text-gray-400 mb-4">
              This will permanently delete the bridge and revoke its token. Type{' '}
              <code className="text-gray-200 bg-gray-800 px-1.5 py-0.5 rounded">{deletingBridge.name}</code>{' '}
              to confirm.
            </p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              placeholder={deletingBridge.name}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500 mb-4"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDeletingBridge(null);
                  setDeleteConfirmName('');
                }
              }}
            />
            {deleteMutation.isError && (
              <p className="text-xs text-red-400 mb-3">{deleteMutation.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeletingBridge(null);
                  setDeleteConfirmName('');
                }}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deletingBridge.id)}
                disabled={deleteConfirmName !== deletingBridge.name || deleteMutation.isPending}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
