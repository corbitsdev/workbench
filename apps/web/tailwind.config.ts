import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // Brand colors (reference CSS variables)
        orange: {
          DEFAULT: 'var(--orange)',
          deep: 'var(--orange-deep)',
          soft: 'var(--orange-soft)',
        },
        blue: {
          DEFAULT: 'var(--blue)',
          deep: 'var(--blue-deep)',
          soft: 'var(--blue-soft)',
        },
        green: {
          DEFAULT: 'var(--green)',
          deep: 'var(--green-deep)',
          soft: 'var(--green-soft)',
        },
        cream: {
          DEFAULT: 'var(--cream)',
          deep: 'var(--cream-deep)',
        },
        charcoal: {
          DEFAULT: 'var(--charcoal)',
          2: 'var(--charcoal-2)',
          deep: 'var(--charcoal-deep)',
        },
        // Semantic colors (theme-aware, from CSS variables)
        bg: 'var(--bg)',
        page: 'var(--page)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        text: {
          DEFAULT: 'var(--text)',
          2: 'var(--text-2)',
          3: 'var(--text-3)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        'row-hover': 'var(--row-hover)',
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          border: 'var(--sidebar-border)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
          ring: 'var(--sidebar-ring)',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        panel: 'var(--radius-panel)',
      },
      fontFamily: {
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      transitionTimingFunction: {
        ease: 'var(--ease)',
        spring: 'var(--spring)',
      },
      backgroundColor: {
        page: 'var(--page)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
      },
      textColor: {
        DEFAULT: 'var(--text)',
        secondary: 'var(--text-2)',
        tertiary: 'var(--text-3)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
        strong: 'var(--border-strong)',
      },
    },
  },
  plugins: [],
} satisfies Config;
