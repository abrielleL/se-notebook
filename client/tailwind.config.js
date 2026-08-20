/** @type {import('tailwindcss').Config} */

// ---------------------------------------------------------------------------
// OPSWAT brand theme — Product UI mode, dark.
//
// Source of truth: the opswat-branding kit's `product-ui-theme.css` and
// `tailwind.opswat.preset.js` (Inter, primary #1d6bfc, the dark-* surface
// scale). Product UI mode is the right mode here rather than corporate
// marketing: this is an app/dashboard, not a marketing surface. The two
// palettes are never mixed — the one exception is the document export
// renderer (server/routes/export.js), which produces a white-background
// deliverable and therefore correctly uses corporate navy/blue.
//
// Every value below is a brand token. Nothing here is eyeballed. The few
// derived values (the dark categorical series, surface tints) are marked and
// explained where they appear.
//
// Existing component class names (bg-card, text-text-muted, accent-blue, …)
// are kept and simply repointed at brand values, so the rebrand did not
// require renaming utilities across ~90 components.
// ---------------------------------------------------------------------------

// Brand dark surfaces, darkest first (product-ui-theme.css `--opswat-dark-*`).
const DARK = {
  100: '#273454',  // borders, elevated edges
  200: '#111f42',  // elevated surface / subtle fills
  300: '#081938',  // card + nav surface
  400: '#040d1c'   // app background
};

// Neutrals, dark-mode values from the kit's `.opswat-theme.dark` block.
const INK = {
  primary: '#f4f4f5',   // --opswat-n-1100 (headings)
  secondary: '#cbd3e7', // --opswat-n-900  (body)
  muted: '#838892',     // --opswat-n-500
  dim: '#616875'        // --opswat-n-700
};

// Brand primary, plus the dark-mode step used for accent *text*. #1d6bfc only
// reaches 4.2:1 on the app background, so it is used for fills and the lighter
// --opswat-info step (#5c9bff, 7.1:1) carries text and links.
const PRIMARY = '#1d6bfc';
const PRIMARY_TEXT = '#5c9bff';
const PRIMARY_HOVER = '#4c8bff';

// Status, dark-mode steps from the kit. Reserved for state — never reused as a
// categorical series slot (the series below uses different steps of the same
// hues, so a status color can never impersonate a series).
const STATUS = {
  success: '#4fd15c',
  warning: '#ff9a4d',
  error: '#ff6b66',
  info: '#5c9bff'
};

// Dark-mode categorical series, in fixed order.
//
// The kit ships chart-1..6 for light backgrounds only; validating those against
// the #081938 card surface fails four of the six checks (chroma floor, CVD
// separation, normal-vision floor, lightness band), so a straight copy would be
// wrong. These hold the brand hues and re-step lightness/chroma for the dark
// surface, with the order chosen by enumeration rather than taste. Verified with
// the dataviz validator against surface #081938: worst adjacent CVD ΔE 18.8
// (target 8), normal-vision floor 32.3 (gate 15), all slots ≥ 3:1 contrast.
const SERIES = [
  '#008a00', // chart-2 green, official
  '#1d6bfc', // chart-1 blue, official
  '#e06106', // chart-3 orange, re-stepped
  '#8f47e8', // chart-5 purple, lightened for dark contrast
  '#e51a16', // chart-4 red, lightened for dark contrast
  '#0f8fa3'  // chart-6 teal, chroma lifted to clear the floor
];

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Product UI mode is Inter (per the brand kit). The mono stack is kept
        // for note bodies, transcripts and editors, where character alignment
        // is functional. The kit's mono token is "Simplon Norm Mono", which is
        // not bundled, so its documented fallback chain is used.
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'ui-monospace', 'monospace']
      },
      colors: {
        // --- app surfaces (existing names, brand values) ---
        app: DARK[400],
        sidebar: DARK[300],
        card: DARK[300],
        ai: DARK[200],
        'ai-inset': DARK[400],
        // Recurring surfaces that used to be inline hex literals.
        inset: DARK[400],      // input / well backgrounds sitting on a card
        subtle: DARK[200],     // chips, list rows, quiet panels
        hover: DARK[200],      // row and nav hover
        active: 'rgba(29, 107, 252, 0.16)', // --opswat-primary-light (dark)

        border: {
          DEFAULT: DARK[100],
          ai: DARK[100],
          'ai-accent': PRIMARY,
          inset: DARK[200]
        },

        text: {
          primary: INK.primary,
          secondary: INK.secondary,
          muted: INK.muted,
          dim: INK.dim
        },

        // --- accents (existing names, brand values) ---
        accent: {
          blue: PRIMARY_TEXT,
          'blue-solid': PRIMARY,
          'blue-hover': PRIMARY_HOVER,
          green: STATUS.success,
          yellow: STATUS.warning,
          orange: STATUS.warning,
          red: STATUS.error,
          purple: SERIES[3],
          'green-bright': STATUS.success
        },

        // --- brand tokens, available directly ---
        primary: { DEFAULT: PRIMARY, hover: PRIMARY_HOVER, text: PRIMARY_TEXT },
        dark: DARK,
        status: STATUS,
        series: Object.fromEntries(SERIES.map((c, i) => [i + 1, c])),

        // Status tints for banner backgrounds/borders (were inline hexes).
        tint: {
          success: 'rgba(0, 138, 0, 0.18)',
          'success-border': 'rgba(79, 209, 92, 0.35)',
          warning: 'rgba(237, 103, 6, 0.18)',
          'warning-border': 'rgba(255, 154, 77, 0.35)',
          error: 'rgba(208, 3, 0, 0.18)',
          'error-border': 'rgba(255, 107, 102, 0.35)',
          info: 'rgba(29, 107, 252, 0.18)',
          'info-border': 'rgba(92, 155, 255, 0.35)'
        }
      },
      borderRadius: { sm: '4px', md: '6px', lg: '8px' },
      boxShadow: {
        'opswat-sm': '0 2px 8px rgba(0, 0, 0, 0.35)',
        'opswat-md': '0 4px 16px rgba(0, 0, 0, 0.45)',
        'opswat-focus': '0 0 0 2px #5c9bff'
      }
    }
  },
  plugins: []
};

// Exported so the app (chart series, account/POV color cycles) reads the same
// validated values rather than re-declaring them.
export { SERIES, DARK, INK, STATUS, PRIMARY, PRIMARY_TEXT };
