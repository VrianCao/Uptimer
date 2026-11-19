import { Suspense, lazy } from 'react';
import { ContentErrorBoundary } from './ContentErrorBoundary';

// Load react-markdown on demand so the status page can render faster.
const ReactMarkdown = lazy(() => import('react-markdown'));

export function Markdown({ text }: { text: string }) {
  const fallback = <div className="whitespace-pre-wrap break-words">{text}</div>;
  return (
    <div className="markdown-preview text-sm leading-relaxed text-gray-800 dark:text-slate-200">
      <ContentErrorBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <ReactMarkdown>{text}</ReactMarkdown>
        </Suspense>
      </ContentErrorBoundary>
    </div>
  );
}
