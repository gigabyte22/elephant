import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router, Switch } from 'wouter';
import { AuthError } from './api/client.ts';
import { AuthGate } from './components/AuthGate.tsx';
import { AppShell } from './components/shell/AppShell.tsx';
import { Audit } from './pages/Audit.tsx';
import { Dreams } from './pages/Dreams.tsx';
import { Entities } from './pages/Entities.tsx';
import { Facts } from './pages/Facts.tsx';
import { GraphExplorer } from './pages/GraphExplorer.tsx';
import { MemoryHealth } from './pages/MemoryHealth.tsx';
import { Overview } from './pages/Overview.tsx';
import { Placeholder } from './pages/Placeholder.tsx';
import { Timeline } from './pages/Timeline.tsx';

// React Query is configured to retry only network failures — auth and 4xx
// errors should surface immediately so the AuthGate can prompt or the user
// can see what's wrong.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, err) => {
        if (err instanceof AuthError) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

// All routes mount under the /dashboard base, matching the Fastify static
// prefix. Wouter's <Router base> normalizes incoming locations.

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <Router base="/dashboard">
          <AppShell>
            <Switch>
              <Route path="/" component={Overview} />
              <Route path="/graph" component={GraphExplorer} />
              <Route path="/facts" component={Facts} />
              <Route path="/entities" component={Entities} />
              <Route path="/timeline" component={Timeline} />
              <Route path="/dreams" component={Dreams} />
              <Route path="/health" component={MemoryHealth} />
              <Route path="/audit" component={Audit} />
              <Route>
                <Placeholder
                  rank={0}
                  label="not found"
                  description="The path you requested isn't part of this dashboard. Use the sidebar to navigate."
                />
              </Route>
            </Switch>
          </AppShell>
        </Router>
      </AuthGate>
    </QueryClientProvider>
  );
}
