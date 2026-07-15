import { useEffect, useState } from 'react';

// Tracks a CSS media query as React state. Used where mobile/desktop differ
// structurally (drawer vs rail, bottom sheet vs slide-over) — anything a
// Tailwind `md:` class can express should keep using classes instead.

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

// The single mobile/desktop pivot used across the dashboard.
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)');
}
