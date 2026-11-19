import { Suspense, lazy } from 'react';
import { Link, createBrowserRouter, isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { StatusPage } from '../pages/StatusPage';
import { Button } from '../components/ui';
import { ADMIN_ANALYTICS_PATH, ADMIN_LOGIN_PATH, ADMIN_PATH } from './adminPaths';
import { useI18n } from './I18nContext';
import { ProtectedRoute } from './ProtectedRoute';

const AdminDashboard = lazy(async () => {
  const mod = await import('../pages/AdminDashboard');
  return { default: mod.AdminDashboard };
});

const AdminAnalytics = lazy(async () => {
  const mod = await import('../pages/AdminAnalytics');
  return { default: mod.AdminAnalytics };
});

const IncidentHistoryPage = lazy(async () => {
  const mod = await import('../pages/IncidentHistoryPage');
  return { default: mod.IncidentHistoryPage };
});

const MaintenanceHistoryPage = lazy(async () => {
  const mod = await import('../pages/MaintenanceHistoryPage');
  return { default: mod.MaintenanceHistoryPage };
});

const AdminLogin = lazy(async () => {
  const mod = await import('../pages/AdminLogin');
  return { default: mod.AdminLogin };
});

function PageFallback() {
  return <div className="min-h-screen bg-slate-50 dark:bg-slate-900" />;
}

function PageError() {
  const { t } = useI18n();
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="min-h-screen bg-slate-50 p-6 dark:bg-slate-900 dark:text-slate-100">
      <div className="mx-auto max-w-lg py-12">
        <h1 role="alert" className="text-xl font-semibold">
          {t(missing ? 'common.page_not_found' : 'common.page_load_error')}
        </h1>
        <div className="mt-4 flex items-center gap-4">
          {!missing && (
            <Button onClick={() => window.location.reload()}>{t('common.reload_page')}</Button>
          )}
          <Link to="/" className="text-sm underline">
            {t('history.back_aria')}
          </Link>
        </div>
      </div>
    </main>
  );
}

export const router = createBrowserRouter([
  { path: '/', element: <StatusPage />, errorElement: <PageError /> },
  {
    path: '/history/incidents',
    errorElement: <PageError />,
    element: (
      <Suspense fallback={<PageFallback />}>
        <IncidentHistoryPage />
      </Suspense>
    ),
  },
  {
    path: '/history/maintenance',
    errorElement: <PageError />,
    element: (
      <Suspense fallback={<PageFallback />}>
        <MaintenanceHistoryPage />
      </Suspense>
    ),
  },
  {
    path: ADMIN_PATH,
    errorElement: <PageError />,
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageFallback />}>
          <AdminDashboard />
        </Suspense>
      </ProtectedRoute>
    ),
  },
  {
    path: ADMIN_ANALYTICS_PATH,
    errorElement: <PageError />,
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageFallback />}>
          <AdminAnalytics />
        </Suspense>
      </ProtectedRoute>
    ),
  },
  {
    path: ADMIN_LOGIN_PATH,
    errorElement: <PageError />,
    element: (
      <Suspense fallback={<PageFallback />}>
        <AdminLogin />
      </Suspense>
    ),
  },
]);
