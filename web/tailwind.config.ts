import type { Config } from 'tailwindcss';

// Aesthetic: "JOI projection" — Bladerunner 2049, Ana de Armas's holographic
// AI. Magenta-pink primary against a cool noir void, electric cyan as the
// connector / data tone, subtle scanlines + grain to sell the "projection"
// tell. Volumetric light, not gradients.

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter var', 'Inter', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        display: ['"Big Shoulders Display"', '"JetBrains Mono"', 'monospace'],
      },
      colors: {
        // Ink — primary value-bearing neutral. Cooler than the previous theme
        // so the magenta + cyan accents read against neutral-blue background
        // grain instead of warm gray.
        ink: {
          50: '#F2F0F7',
          100: '#E6E1ED',
          200: '#C2BFD0',
          300: '#A4A0B5',
          400: '#6A6580',
          500: '#3D3A4C',
          600: '#1F1D29',
          700: '#14121C',
          800: '#0C0A14',
          900: '#06050C',
        },
        // JOI — the primary accent. Hot pink/magenta. Used wherever the
        // previous theme used amber: active nav, primary numerics, focus
        // glow, sparkline strokes.
        accent: {
          300: '#FFB0CD',
          400: '#FF8AB8',
          500: '#FF5C8A',
          600: '#E64475',
          700: '#C7456E',
        },
        // Cyan — the secondary connector. Replaces sage. Used for status,
        // entities in the graph, "alive" indicators.
        cyan: {
          300: '#8FF0E6',
          400: '#5EE3D8',
          500: '#3FB8AE',
          600: '#2D8A82',
        },
        sage: '#5EE3D8',
        rust: '#D26B8C',
      },
      borderColor: {
        // Hairlines carry a faint pink cast so even the "neutral" structure
        // tints toward the projection palette.
        hairline: 'rgba(255, 196, 225, 0.06)',
        'hairline-strong': 'rgba(255, 196, 225, 0.14)',
      },
      backgroundColor: {
        hairline: 'rgba(255, 196, 225, 0.06)',
      },
      letterSpacing: {
        wider: '0.08em',
        widest: '0.16em',
        kerned: '0.22em',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        display: ['4.5rem', { lineHeight: '0.95', letterSpacing: '-0.01em' }],
        'display-sm': ['3rem', { lineHeight: '0.95', letterSpacing: '-0.01em' }],
      },
      boxShadow: {
        // Soft pink halos used for "this is the active hologram" emphasis.
        // Layered: a tight inner glow + a wider, dimmer outer bloom.
        'halo-sm': '0 0 8px rgba(255,92,138,0.35)',
        halo: '0 0 14px rgba(255,92,138,0.40), 0 0 36px rgba(255,92,138,0.14)',
        'halo-lg':
          '0 0 18px rgba(255,92,138,0.50), 0 0 48px rgba(255,92,138,0.18), 0 0 96px rgba(94,227,216,0.06)',
        ringed: 'inset 0 0 0 1px rgba(255,92,138,0.55)',
        panel: '0 1px 0 rgba(255,196,225,0.04), 0 0 0 1px rgba(255,196,225,0.06)',
      },
      dropShadow: {
        accent: '0 0 4px rgba(255,92,138,0.55)',
        cyan: '0 0 4px rgba(94,227,216,0.55)',
      },
      animation: {
        'fade-up': 'fade-up 320ms cubic-bezier(0.16, 1, 0.3, 1) both',
        // Joi-projector tells: a hairline scan that drifts down a panel
        // every ~7s, and a soft pulse on "live" indicators.
        drift: 'drift 7s linear infinite',
        pulse: 'projector-pulse 2.4s ease-in-out infinite',
        scan: 'scan 1.4s ease-in-out infinite',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        drift: {
          '0%': { transform: 'translateY(-8%)', opacity: '0' },
          '8%': { opacity: '1' },
          '92%': { opacity: '1' },
          '100%': { transform: 'translateY(108%)', opacity: '0' },
        },
        'projector-pulse': {
          '0%, 100%': {
            opacity: '0.7',
            boxShadow: '0 0 6px rgba(255,92,138,0.45)',
          },
          '50%': {
            opacity: '1',
            boxShadow: '0 0 14px rgba(255,92,138,0.85)',
          },
        },
        scan: {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '0.85' },
        },
      },
      spacing: {
        '0.25': '1px',
        '0.75': '3px',
      },
    },
  },
  plugins: [],
} satisfies Config;
