import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, Copy } from 'lucide-react';
import { api } from '../api/client';
import { TemplateEditor } from '../components/TemplateEditor';


export function TemplatesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editType, setEditType] = useState<'dockerfile' | 'compose'>('dockerfile');
  const [isDirty, setIsDirty] = useState(false);

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.listTemplates(),
  });

  const selected = templates.find((t) => t.id === selectedId);

  // Sync editor state when selected template changes
  const [prevSelected, setPrevSelected] = useState(selected);
  if (selected && selected !== prevSelected) {
    setPrevSelected(selected);
    setEditName(selected.name);
    setEditContent(selected.content);
    setEditType(selected.type);
    setIsDirty(false);
  }
  if (!selected && prevSelected) {
    setPrevSelected(undefined);
  }

  // Auto-select first template
  if (!selectedId && templates.length > 0) {
    setSelectedId(templates[0].id);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateTemplate(selectedId!, {
        name: editName,
        content: editContent,
        type: editType,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setIsDirty(false);
    },
  });

  const saveAsMutation = useMutation({
    mutationFn: () =>
      api.createTemplate({
        name: editName + ' (copy)',
        type: editType,
        content: editContent,
        buildArgs: {},
        defaultVolumes: [],
        defaultEnv: {},
      }),
    onSuccess: (newTemplate) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setSelectedId(newTemplate.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteTemplate(selectedId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setSelectedId(null);
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createTemplate({
        name: 'new-template',
        type: 'dockerfile',
        content: 'FROM ubuntu:24.04\n\nRUN apt-get update && apt-get install -y \\\n    tmux \\\n    && rm -rf /var/lib/apt/lists/*\n\nCMD ["tmux", "new-session", "-s", "main"]\n',
        buildArgs: {},
        defaultVolumes: [],
        defaultEnv: {},
      }),
    onSuccess: (newTemplate) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setSelectedId(newTemplate.id);
    },
  });

  return (
    <div className="flex h-full">
      {/* Template list */}
      <div className="w-56 border-r border-gray-800 flex flex-col shrink-0">
        <div className="flex items-center justify-between px-3 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-300">Templates</h2>
          <button
            onClick={() => createMutation.mutate()}
            className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            title="New Template"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                selectedId === t.id
                  ? 'bg-gray-800 text-blue-400'
                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
              }`}
            >
              <div className="font-medium truncate">{t.name}</div>
              <div className="text-xs text-gray-600 mt-0.5">{t.type}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
              <input
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  setIsDirty(true);
                }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
              />
              <select
                value={editType}
                onChange={(e) => {
                  setEditType(e.target.value as 'dockerfile' | 'compose');
                  setIsDirty(true);
                }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
              >
                <option value="dockerfile">Dockerfile</option>
                <option value="compose">Compose</option>
              </select>
              <div className="flex-1" />
              {isDirty && (
                <span className="text-xs text-yellow-500">Unsaved changes</span>
              )}
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!isDirty || saveMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Save size={14} />
                Save
              </button>
              <button
                onClick={() => saveAsMutation.mutate()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <Copy size={14} />
                Save As New
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete template "${selected.name}"?`)) {
                    deleteMutation.mutate();
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-400 hover:bg-red-900/30 transition-colors"
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
            <div className="flex-1">
              <TemplateEditor
                value={editContent}
                onChange={(v) => {
                  setEditContent(v);
                  setIsDirty(true);
                }}
                language={editType === 'compose' ? 'yaml' : 'dockerfile'}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a template or create a new one
          </div>
        )}
      </div>
    </div>
  );
}
