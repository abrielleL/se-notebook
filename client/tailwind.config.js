/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      colors: {
        app: '#0d0f12',
        sidebar: '#080a0d',
        card: '#0d1117',
        ai: '#0a1628',
        'ai-inset': '#080e1a',
        border: {
          DEFAULT: '#1e2530',
          ai: '#1a3a6e',
          'ai-accent': '#2d5a9e',
          inset: '#1a1f2e'
        },
        text: {
          primary: '#e6edf3',
          secondary: '#c9d1d9',
          muted: '#8b949e',
          dim: '#4a5568'
        },
        accent: {
          blue: '#58a6ff',
          green: '#3fb950',
          yellow: '#e3b341',
          purple: '#bc8cff',
          orange: '#f0883e',
          red: '#f85149',
          'green-bright': '#26a641'
        }
      }
    }
  },
  plugins: []
};
