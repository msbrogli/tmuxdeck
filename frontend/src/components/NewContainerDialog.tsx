import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Circle,
} from 'lucide-react';
import { api, createContainerStream } from '../api/client';
import type { ContainerStreamEvent } from '../types';

interface NewContainerDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

type Phase = 'form' | 'creating' | 'done' | 'error';

const STEPS = [
  { key: 'building_image', label: 'Building image' },
  { key: 'creating_container', label: 'Creating container' },
  { key: 'starting_container', label: 'Starting container' },
  { key: 'initializing', label: 'Initializing tmux session' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];
type StepStatus = 'pending' | 'active' | 'done' | 'error';

export function NewContainerDialog({ onClose, onCreated }: NewContainerDialogProps) {
  const [name, setName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [mountSsh, setMountSsh] = useState(true);
  const [mountClaude, setMountClaude] = useState(true);

  const [phase, setPhase] = useState<Phase>('form');
  const [stepStatuses, setStepStatuses] = useState<Record<StepKey, StepStatus>>({
    building_image: 'pending',
    creating_container: 'pending',
    starting_container: 'pending',
    initializing: 'pending',
  });
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [logsExpanded, setLogsExpanded] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.listTemplates(),
  });

  // Auto-scroll build logs
  useEffect(() => {
    if (logsExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [buildLogs, logsExpanded]);

  const selectedTemplateData = templates.find((t) => t.id === selectedTemplate);

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplate(id);
    const tmpl = templates.find((t) => t.id === id);
    if (tmpl) {
      setVolumes([...tmpl.defaultVolumes]);
      setEnvVars(
        Object.entries(tmpl.defaultEnv).map(([key, value]) => ({ key, value })),
      );
    }
  };

  const handleEvent = useCallback((event: ContainerStreamEvent) => {
    if (event.event === 'step') {
      const stepKey = event.step as StepKey;
      setStepStatuses((prev) => {
        const next = { ...prev };
        // Mark all previous steps as done
        for (const s of STEPS) {
          if (s.key === stepKey) break;
          if (next[s.key] === 'active') next[s.key] = 'done';
        }
        next[stepKey] = 'active';
        return next;
      });
      if (stepKey === 'building_image') {
        setLogsExpanded(true);
      }
    } else if (event.event === 'log') {
      setBuildLogs((prev) => [...prev, event.line]);
    } else if (event.event === 'error') {
      if (event.step) {
        setStepStatuses((prev) => ({
          ...prev,
          [event.step as StepKey]: 'error',
        }));
      }
    }
  }, []);

  const handleCreate = async () => {
    setPhase('creating');
    setBuildLogs([]);
    setErrorMessage('');
    setStepStatuses({
      building_image: 'pending',
      creating_container: 'pending',
      starting_container: 'pending',
      initializing: 'pending',
    });

    try {
      await createContainerStream(
        {
          templateId: selectedTemplate,
          name,
          env: Object.fromEntries(envVars.filter((e) => e.key).map((e) => [e.key, e.value])),
          volumes,
          mountSsh,
          mountClaude,
        },
        handleEvent,
      );

      // Mark all steps done
      setStepStatuses({
        building_image: 'done',
        creating_container: 'done',
        starting_container: 'done',
        initializing: 'done',
      });
      setPhase('done');

      // Auto-close after 800ms
      setTimeout(() => {
        onCreated();
      }, 800);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const handleRetry = () => {
    handleCreate();
  };

  const StepIndicator = ({ stepKey }: { stepKey: StepKey }) => {
    const status = stepStatuses[stepKey];
    const label = STEPS.find((s) => s.key === stepKey)!.label;

    return (
      <div className="flex items-center gap-2 py-1">
        {status === 'active' && <Loader2 size={16} className="text-blue-400 animate-spin" />}
        {status === 'done' && <CheckCircle2 size={16} className="text-green-400" />}
        {status === 'error' && <XCircle size={16} className="text-red-400" />}
        {status === 'pending' && <Circle size={16} className="text-gray-600" />}
        <span
          className={`text-sm ${
            status === 'active'
              ? 'text-blue-300'
              : status === 'done'
                ? 'text-green-300'
                : status === 'error'
                  ? 'text-red-300'
                  : 'text-gray-500'
          }`}
        >
          {label}
        </span>
      </div>
    );
  };

  const isCreating = phase === 'creating' || phase === 'done';

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={phase === 'creating' ? undefined : onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">New Container</h2>
          {phase !== 'creating' && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {phase === 'form' && (
            <>
              {/* Template Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Template</label>
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => handleSelectTemplate(t.id)}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        selectedTemplate === t.id
                          ? 'border-blue-500 bg-blue-900/20 text-blue-300'
                          : 'border-gray-700 hover:border-gray-600 text-gray-300'
                      }`}
                    >
                      <div className="font-medium text-sm">{t.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{t.type}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Container Name */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Container Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-project"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              {/* Mount Options */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Mount Options</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mountSsh}
                      onChange={(e) => setMountSsh(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-600 accent-blue-500"
                    />
                    <span className="text-sm text-gray-300">Mount SSH config</span>
                    <span className="text-xs text-gray-500">(~/.ssh)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mountClaude}
                      onChange={(e) => setMountClaude(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-600 accent-blue-500"
                    />
                    <span className="text-sm text-gray-300">Mount Claude config</span>
                    <span className="text-xs text-gray-500">(~/.claude)</span>
                  </label>
                </div>
              </div>

              {/* Volume Mounts */}
              {selectedTemplateData && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Volume Mounts</label>
                  {volumes.map((vol, i) => (
                    <div key={i} className="flex items-center gap-2 mb-1">
                      <input
                        value={vol}
                        onChange={(e) => {
                          const newVols = [...volumes];
                          newVols[i] = e.target.value;
                          setVolumes(newVols);
                        }}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500 font-mono"
                      />
                      <button
                        onClick={() => setVolumes(volumes.filter((_, j) => j !== i))}
                        className="p-1 text-gray-500 hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setVolumes([...volumes, ''])}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    + Add volume
                  </button>
                </div>
              )}

              {/* Environment Variables */}
              {selectedTemplateData && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Environment Variables
                  </label>
                  {envVars.map((env, i) => (
                    <div key={i} className="flex items-center gap-2 mb-1">
                      <input
                        value={env.key}
                        onChange={(e) => {
                          const newEnv = [...envVars];
                          newEnv[i] = { ...env, key: e.target.value };
                          setEnvVars(newEnv);
                        }}
                        placeholder="KEY"
                        className="w-1/3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500 font-mono"
                      />
                      <input
                        value={env.value}
                        onChange={(e) => {
                          const newEnv = [...envVars];
                          newEnv[i] = { ...env, value: e.target.value };
                          setEnvVars(newEnv);
                        }}
                        placeholder="value"
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500 font-mono"
                      />
                      <button
                        onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                        className="p-1 text-gray-500 hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    + Add variable
                  </button>
                </div>
              )}
            </>
          )}

          {(isCreating || phase === 'error') && (
            <>
              {/* Step indicators */}
              <div className="space-y-1">
                {STEPS.map((s) => (
                  <StepIndicator key={s.key} stepKey={s.key} />
                ))}
              </div>

              {/* Build logs */}
              {buildLogs.length > 0 && (
                <div>
                  <button
                    onClick={() => setLogsExpanded(!logsExpanded)}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300 mb-1"
                  >
                    {logsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Build logs ({buildLogs.length} lines)
                  </button>
                  {logsExpanded && (
                    <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs text-gray-400 leading-relaxed">
                      {buildLogs.map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                      <div ref={logEndRef} />
                    </div>
                  )}
                </div>
              )}

              {/* Error message */}
              {phase === 'error' && (
                <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-sm text-red-300">
                  {errorMessage}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-800">
          {phase === 'form' && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || !selectedTemplate}
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Create Container
              </button>
            </>
          )}
          {phase === 'creating' && (
            <span className="text-sm text-gray-500">Creating container...</span>
          )}
          {phase === 'done' && (
            <span className="text-sm text-green-400">Container created successfully!</span>
          )}
          {phase === 'error' && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleRetry}
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
