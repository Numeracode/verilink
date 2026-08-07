import { Navigate, Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { useAuth } from './auth/AuthProvider';
import { LoginPage } from './pages/LoginPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { ProviderHomePage } from './pages/ProviderHomePage';
import { AgentBuilderHomePage } from './pages/AgentBuilderHomePage';
import { AdminHomePage } from './pages/AdminHomePage';

function RequireAuth() {
  const auth = useAuth();
  if (!auth.isAuthenticated) {
    return <Navigate to="/login" />;
  }
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function IndexRedirect() {
    const auth = useAuth();
    return <Navigate to={auth.isAuthenticated ? '/provider' : '/login'} />;
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallbackPage,
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  component: RequireAuth,
});

const providerRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/provider',
  component: ProviderHomePage,
});

const agentBuilderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/agent-builder',
  component: AgentBuilderHomePage,
});

const adminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin',
  component: AdminHomePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  callbackRoute,
  authedRoute.addChildren([providerRoute, agentBuilderRoute, adminRoute]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
