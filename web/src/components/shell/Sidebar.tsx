import { Link, useLocation } from 'wouter';
import { clearToken } from '../../lib/auth.ts';

// Narrow left rail. Each nav item is a monospace label; the active row is
// marked by a 2px accent tick on its left edge — the same tick used in the
// brand mark, reinforcing the visual identifier. Below md the AppShell hosts
// this same rail inside a drawer and passes onNavigate to dismiss it.

interface NavRow {
  href: string;
  label: string;
  hint: string;
}

const NAV: NavRow[] = [
  { href: '/', label: 'overview', hint: 'OV' },
  { href: '/graph', label: 'graph', hint: 'GR' },
  { href: '/facts', label: 'facts', hint: 'FT' },
  { href: '/entities', label: 'entities', hint: 'EN' },
  { href: '/documents', label: 'documents', hint: 'DO' },
  { href: '/timeline', label: 'timeline', hint: 'TL' },
  { href: '/dreams', label: 'dreams', hint: 'DR' },
  { href: '/health', label: 'health', hint: 'HL' },
  { href: '/audit', label: 'audit', hint: 'AU' },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-hairline bg-ink-900/40">
      <nav className="flex-1 overflow-y-auto py-8">
        <ol className="flex flex-col">
          {NAV.map((row, i) => {
            const isActive = matchPath(location, row.href);
            return (
              <li key={row.href}>
                <Link
                  href={row.href}
                  onClick={onNavigate}
                  className={`group relative flex items-center gap-4 pl-6 pr-5 py-2.5 font-mono text-xs uppercase tracking-widest transition-colors ${
                    isActive ? 'text-ink-100' : 'text-ink-300 hover:text-ink-100'
                  }`}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 bg-accent-500"
                      style={{ boxShadow: '0 0 10px rgba(255,92,138,0.75)' }}
                      aria-hidden
                    />
                  )}
                  <span
                    className={`font-mono text-2xs tabular-nums ${
                      isActive ? 'text-accent-500' : 'text-ink-500'
                    }`}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1">{row.label}</span>
                  <span
                    className={`font-mono text-2xs ${
                      isActive
                        ? 'text-ink-400'
                        : 'text-ink-500/70 opacity-0 group-hover:opacity-100'
                    } transition-opacity`}
                  >
                    {row.hint}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="border-t border-hairline px-6 py-5">
        <button
          type="button"
          onClick={() => {
            clearToken();
            window.location.reload();
          }}
          className="font-mono text-2xs uppercase tracking-widest text-ink-400 transition-colors hover:text-rust"
        >
          sign out
        </button>
      </div>
    </aside>
  );
}

function matchPath(location: string, href: string): boolean {
  if (href === '/') return location === '/' || location === '';
  return location === href || location.startsWith(`${href}/`);
}
