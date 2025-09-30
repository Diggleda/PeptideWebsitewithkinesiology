# Project Structure

## Root
```
├── index.html              # Main HTML entry point
├── package.json            # Dependencies & scripts
├── vite.config.ts          # Vite configuration
├── README.md               # Project documentation
```

## Public Assets
```
public/
├── logo.png               # Site logo
└── ProtixaLogo.PNG        # Brand logo
```

## Source Code
```
src/
├── main.tsx               # Application entry point
├── App.tsx                # Main app component
├── index.css              # Global styles (Tailwind compiled)
├── vite-env.d.ts          # TypeScript definitions
│
├── components/            # React components
│   ├── Header.tsx
│   ├── FeaturedSection.tsx
│   ├── ProductCard.tsx
│   ├── CategoryFilter.tsx
│   ├── CheckoutModal.tsx
│   ├── ImageWithFallback.tsx
│   │
│   └── ui/               # UI primitives (8 components)
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── checkbox.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── label.tsx
│       ├── separator.tsx
│       ├── slider.tsx
│       └── utils.ts
│
└── data/
    └── mockData.ts        # Sample product data
```

## What Changed

### Removed
- ❌ 40+ unused UI components (kept only 9 actually used)
- ❌ Duplicate `build/` and `assets/` folders at root
- ❌ Nested `figma/` subfolder (flattened into components/)
- ❌ Empty `src/styles/` folder
- ❌ Duplicate `globals.css` (using Tailwind's compiled output)
- ❌ `src/assets/` folder (moved to public/)
- ❌ Metadata files (.DS_Store, Attributions.md)

### Simplified
- ✅ Flat component structure (no unnecessary nesting)
- ✅ Only 9 UI components instead of 48
- ✅ Single styles file (index.css)
- ✅ Assets in public/ folder
- ✅ Clear 3-level max folder depth

## Development
```bash
npm run dev    # Start dev server
npm run build  # Build for production
```
