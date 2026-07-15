import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { useIsDesktop } from '../../hooks/useMediaQuery.ts';
import { useScope } from '../../hooks/useScope.ts';
import { type Scope, activeScopeAxes, scopeToQueryString } from '../../lib/scope.ts';

// Global scope filter. The user can pin one or more axes (project, user,
// agent, session); the values ride on the URL query string so deep-links
// preserve filter state. Active filters render as monospaced chips with a
// hover-clear affordance. Below md the bar collapses to a single count chip
// that expands in place (the header wraps to fit).

const AXES: Array<{ key: keyof Scope; label: string }> = [
  { key: 'projectId', label: 'project' },
  { key: 'userId', label: 'user' },
  { key: 'agentId', label: 'agent' },
  { key: 'sessionId', label: 'session' },
];

export function ScopeBar() {
  const scope = useScope();
  const [, setLocation] = useLocation();
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const desktop = useIsDesktop();

  function applyScope(next: Scope) {
    const qs = scopeToQueryString(next);
    setLocation(`${window.location.pathname}${qs}`);
    setEditing(false);
  }

  const active = activeScopeAxes(scope);

  if (!desktop && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={`flex shrink-0 items-baseline gap-2 border px-2.5 py-1 font-mono text-2xs uppercase tracking-widest transition-colors ${
          active.length > 0
            ? 'border-accent-500/60 text-ink-100'
            : 'border-hairline-strong text-ink-400'
        }`}
      >
        <span>scope</span>
        <span className={active.length > 0 ? 'text-accent-300' : 'text-ink-500'}>
          {active.length > 0 ? active.length : 'all'}
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 text-ink-300">
      {!desktop && (
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setEditing(false);
          }}
          aria-label="collapse scope bar"
          className="font-mono text-2xs uppercase tracking-widest text-ink-400 transition-colors hover:text-accent-300"
        >
          ✕
        </button>
      )}
      <span className="label-meta">scope</span>
      <div className="flex flex-wrap items-center gap-2">
        {active.length === 0 && !editing && (
          <span className="font-mono text-2xs uppercase tracking-widest text-ink-500">
            (global)
          </span>
        )}
        {active.map(({ key, value }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              const next = { ...scope };
              delete next[key];
              applyScope(next);
            }}
            className="group flex items-baseline gap-2 border border-hairline px-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-ink-100 transition-colors hover:border-rust hover:text-rust"
            title="click to clear"
          >
            <span className="text-ink-400 group-hover:text-rust">{axisLabel(key)}</span>
            <span className="text-ink-100 group-hover:text-rust normal-case tracking-normal">
              {value}
            </span>
          </button>
        ))}
        {editing ? (
          <ScopeEditor initial={scope} onApply={applyScope} onCancel={() => setEditing(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="border border-dashed border-hairline-strong px-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-ink-400 transition-colors hover:border-accent-500 hover:text-accent-300"
          >
            + add filter
          </button>
        )}
      </div>
    </div>
  );
}

function axisLabel(key: keyof Scope): string {
  return AXES.find((a) => a.key === key)?.label ?? key;
}

interface EditorProps {
  initial: Scope;
  onApply: (next: Scope) => void;
  onCancel: () => void;
}

function ScopeEditor({ initial, onApply, onCancel }: EditorProps) {
  const [axis, setAxis] = useState<keyof Scope>(
    AXES.find((a) => !initial[a.key])?.key ?? 'projectId',
  );
  const [value, setValue] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onApply({ ...initial, [axis]: trimmed });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-baseline gap-2 border border-accent-500/60 bg-ink-900 px-2 py-1"
    >
      <select
        value={axis}
        onChange={(e) => setAxis(e.target.value as keyof Scope)}
        className="bg-transparent font-mono text-2xs uppercase tracking-widest text-ink-100 focus:outline-none"
      >
        {AXES.map((a) => (
          <option key={a.key} value={a.key} className="bg-ink-900">
            {a.label}
          </option>
        ))}
      </select>
      <span className="text-ink-500">=</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: keyboard-first inline editor; focus is the expected affordance
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="value"
        className="w-32 border-0 bg-transparent font-mono text-2xs text-ink-100 placeholder:text-ink-500 focus:outline-none"
      />
      <button
        type="submit"
        className="font-mono text-2xs uppercase tracking-widest text-accent-500"
      >
        apply
      </button>
    </form>
  );
}
