import { type ReactNode, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Brand } from './Brand.tsx';
import { ScopeBar } from './ScopeBar.tsx';
import { Sidebar } from './Sidebar.tsx';

// Two-region layout: narrow sidebar + main column. Header carries the brand
// glyph on the left and the global scope filter bar on the right, separated
// by a hairline strip. The main column owns its own scrolling so the sidebar
// stays pinned. Below md the rail hides behind a hamburger-opened drawer in
// the same projected-glass treatment as the cosmos panels.

interface Props {
  children: ReactNode;
}

export function AppShell({ children }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [location] = useLocation();

  // Navigating (via drawer link or otherwise) always dismisses the drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location is the trigger
  useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b border-hairline px-4 py-4 sm:px-6 md:px-10 md:py-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="open navigation"
              className="flex h-8 w-8 shrink-0 flex-col items-center justify-center gap-[5px] border border-hairline-strong transition-colors hover:border-accent-500 md:hidden"
            >
              <span className="block h-px w-4 bg-ink-300" aria-hidden />
              <span className="block h-px w-4 bg-ink-300" aria-hidden />
              <span className="block h-px w-4 bg-ink-300" aria-hidden />
            </button>
            <Brand />
          </div>
          <ScopeBar />
        </header>
        {/* flex-col so full-bleed pages (GraphExplorer) can flex-1 to the exact
            remaining height instead of guessing with 100vh math. */}
        <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6 md:px-10 md:py-10">
          {children}
        </div>
      </main>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default bg-ink-900/60"
            onClick={() => setDrawerOpen(false)}
            aria-label="close navigation"
            tabIndex={-1}
          />
          <div className="absolute inset-y-0 left-0 flex w-56 animate-fade-up border-r border-hairline-strong bg-ink-900/90 shadow-panel backdrop-blur-md">
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
