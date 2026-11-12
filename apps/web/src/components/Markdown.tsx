import { Suspense, lazy } from 'react';

// Load react-markdown on demand so the status page can render faster.
const ReactMarkdown = lazy(() => import('react-markdown'));

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-preview text-sm leading-relaxed text-gray-800 dark:text-slate-200">
      <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}>
        <ReactMarkdown>{text}</ReactMarkdown>
      </Suspense>
    </div>
  );
}
