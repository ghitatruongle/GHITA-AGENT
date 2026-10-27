# GHITA Documentation

This is the Docusaurus documentation site for Ghita Agent (v0.0.3).

## Develop

```bash
pnpm install
pnpm start
```

Site opens at http://localhost:3000.

## Build

```bash
pnpm build
```

Output goes to `build/`.

## Structure

```
docs/
├── docusaurus.config.ts   # Main configuration
├── sidebars.ts            # Sidebar definitions
├── package.json
├── tsconfig.json
├── docs/                  # Markdown content
│   ├── intro.md
│   ├── getting-started.md
│   ├── architecture.md
│   ├── features/
│   ├── tutorials/
│   └── api/
├── src/
│   ├── css/custom.css     # Theme overrides
│   └── pages/             # Custom React pages (optional)
├── static/                # Static assets (img, favicon)
└── README.md
```

## Adding a New Page

1. Create `docs/<section>/<page>.md` with frontmatter:

```markdown
---
id: my-page
title: My Page
sidebar_label: My Page
sidebar_position: 1
---

# My Page

Content...
```

2. Add to `sidebars.ts` if explicit registration is needed.

## Deploy

Build static files:

```bash
pnpm build
```

Deploy `build/` to:

- Vercel: `vercel deploy --prebuilt`
- Netlify: drag `build/` into dashboard
- GitHub Pages: copy `build/` to `gh-pages` branch
