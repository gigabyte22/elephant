// Brand mark — the elephant logo rendered as a circular emblem with a soft
// accent drop-shadow halo so it reads as "projected light" rather than a
// flat icon. The wordmark stays in JetBrains Mono with the kerned accent tick
// between name and subtitle.

import elephantLogo from '../../assets/elephant.jpg';

export function Brand({ subtitle = 'memory inspector' }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 select-none">
      <img
        src={elephantLogo}
        alt="Elephant"
        width="24"
        height="24"
        className="h-6 w-6 rounded-full object-cover"
        style={{ filter: 'drop-shadow(0 0 4px rgba(255,92,138,0.55))' }}
      />
      <div className="flex items-baseline gap-3 leading-none">
        <span className="font-mono text-sm font-medium tracking-widest uppercase text-ink-100">
          elephant
        </span>
        <span className="tick h-3 -mb-0.5" />
        <span className="font-mono text-2xs tracking-kerned uppercase text-ink-300">
          {subtitle}
        </span>
      </div>
    </div>
  );
}
