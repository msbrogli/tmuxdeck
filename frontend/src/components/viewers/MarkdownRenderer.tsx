import { useEffect, useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, theme: 'dark' });

function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '_');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    mermaid.render(`mermaid${id}`, chart).then(
      ({ svg: result }) => { if (!cancelled) setSvg(result); },
      (err) => { if (!cancelled) setError(String(err)); },
    );
    return () => { cancelled = true; };
  }, [id, chart]);

  if (error) {
    return (
      <div className="rounded-lg bg-red-900/30 border border-red-700 p-4 text-sm">
        <div className="text-red-400 mb-2">Mermaid diagram error</div>
        <pre className="text-gray-400 whitespace-pre-wrap">{chart}</pre>
      </div>
    );
  }
  if (!svg) {
    return <div className="text-gray-500 p-4">Rendering diagram...</div>;
  }
  return (
    <div
      className="overflow-x-auto my-4 flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

interface MarkdownRendererProps {
  content: string;
}

const components: Components = {
  h1: ({ children }) => <h1 className="md-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="md-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="md-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="md-h4">{children}</h4>,
  h5: ({ children }) => <h5 className="md-h5">{children}</h5>,
  h6: ({ children }) => <h6 className="md-h6">{children}</h6>,
  code: ({ className, children, ...props }) => {
    const match = className?.match(/language-(\w+)/);
    if (match && match[1] === 'mermaid') {
      return <MermaidDiagram chart={String(children).replace(/\n$/, '')} />;
    }
    if (match) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: 0, borderRadius: '0.5rem' }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      );
    }
    return <code className="md-inline-code" {...props}>{children}</code>;
  },
  pre: ({ children }) => (
    <div className="md-code-block">{children}</div>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="md-ul">{children}</ul>,
  ol: ({ children }) => <ol className="md-ol">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
  hr: () => <hr className="md-hr" />,
  table: ({ children }) => <table className="md-table">{children}</table>,
  img: ({ src, alt }) => <img src={src} alt={alt} className="md-img" />,
};

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="w-[70vw] max-h-[85vh] overflow-auto p-6">
      <div
        className="markdown-body prose prose-invert max-w-none
          [&_.md-h1]:text-3xl [&_.md-h1]:font-bold [&_.md-h1]:mb-4 [&_.md-h1]:mt-6 [&_.md-h1]:border-b [&_.md-h1]:border-gray-700 [&_.md-h1]:pb-2
          [&_.md-h2]:text-2xl [&_.md-h2]:font-bold [&_.md-h2]:mb-3 [&_.md-h2]:mt-5 [&_.md-h2]:border-b [&_.md-h2]:border-gray-700 [&_.md-h2]:pb-2
          [&_.md-h3]:text-xl [&_.md-h3]:font-semibold [&_.md-h3]:mb-2 [&_.md-h3]:mt-4
          [&_.md-h4]:text-lg [&_.md-h4]:font-semibold [&_.md-h4]:mb-2 [&_.md-h4]:mt-3
          [&_.md-h5]:text-base [&_.md-h5]:font-semibold [&_.md-h5]:mb-1 [&_.md-h5]:mt-2
          [&_.md-h6]:text-sm [&_.md-h6]:font-semibold [&_.md-h6]:mb-1 [&_.md-h6]:mt-2
          [&_p]:mb-3 [&_p]:leading-relaxed [&_p]:text-gray-300
          [&_.md-code-block]:bg-gray-800 [&_.md-code-block]:rounded-lg [&_.md-code-block]:p-4 [&_.md-code-block]:my-4 [&_.md-code-block]:overflow-x-auto [&_.md-code-block]:text-sm [&_.md-code-block]:text-gray-300 [&_.md-code-block]:font-mono [&_.md-code-block]:whitespace-pre-wrap
          [&_.md-inline-code]:bg-gray-800 [&_.md-inline-code]:rounded [&_.md-inline-code]:px-1.5 [&_.md-inline-code]:py-0.5 [&_.md-inline-code]:text-sm [&_.md-inline-code]:text-pink-400 [&_.md-inline-code]:font-mono
          [&_.md-code-block_.md-inline-code]:text-gray-300 [&_.md-code-block_.md-inline-code]:bg-transparent [&_.md-code-block_.md-inline-code]:p-0
          [&_.md-link]:text-blue-400 [&_.md-link]:underline [&_.md-link]:hover:text-blue-300
          [&_.md-ul]:list-disc [&_.md-ul]:pl-6 [&_.md-ul]:mb-3 [&_.md-ul]:text-gray-300
          [&_.md-ol]:list-decimal [&_.md-ol]:pl-6 [&_.md-ol]:mb-3 [&_.md-ol]:text-gray-300
          [&_li]:mb-1
          [&_.md-blockquote]:border-l-4 [&_.md-blockquote]:border-gray-600 [&_.md-blockquote]:pl-4 [&_.md-blockquote]:my-3 [&_.md-blockquote]:text-gray-400 [&_.md-blockquote]:italic
          [&_.md-hr]:border-gray-700 [&_.md-hr]:my-6
          [&_strong]:font-bold [&_strong]:text-gray-200
          [&_em]:italic
          [&_del]:line-through [&_del]:text-gray-500
          [&_.md-table]:w-full [&_.md-table]:border-collapse [&_.md-table]:text-sm [&_.md-table]:my-4
          [&_.md-table_th]:bg-gray-800 [&_.md-table_th]:text-gray-200 [&_.md-table_th]:font-semibold [&_.md-table_th]:px-3 [&_.md-table_th]:py-2 [&_.md-table_th]:text-left [&_.md-table_th]:border-b [&_.md-table_th]:border-gray-600
          [&_.md-table_td]:px-3 [&_.md-table_td]:py-1.5 [&_.md-table_td]:text-gray-300 [&_.md-table_td]:border-b [&_.md-table_td]:border-gray-800
          [&_.md-table_tr:nth-child(even)]:bg-gray-900 [&_.md-table_tr:nth-child(odd)]:bg-gray-900/50
        "
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
