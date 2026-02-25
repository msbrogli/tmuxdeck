import Editor from '@monaco-editor/react';

interface TemplateEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
}

export function TemplateEditor({ value, onChange, language }: TemplateEditorProps) {
  return (
    <Editor
      height="100%"
      language={language ?? 'dockerfile'}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        padding: { top: 12 },
        renderLineHighlight: 'line',
        automaticLayout: true,
      }}
    />
  );
}
