// ==============================================================================
// Ghita Agent — Documentation Site (Docusaurus)
// ==============================================================================
// Run: pnpm --filter @ghita/docs start
// Build: pnpm --filter @ghita/docs build

import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Ghita Agent',
  tagline: 'Multi-provider desktop AI agent với skills, computer use, và memory',
  favicon: 'img/favicon.ico',

  url: 'https://ghita.dev',
  baseUrl: '/',

  organizationName: 'ghitatruongle',
  projectName: 'ghita-coding-agent',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  future: {
    faster: {
      swcJsLoader: true,
      swcJsMinimizer: true,
      lightningCssMinimizer: true,
      mdxCrossCompilerCache: true,
    },
  },

  i18n: {
    defaultLocale: 'vi',
    locales: ['vi', 'en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/ghitatruongle/GHITA-AGENT/edit/main/docs/',
          routeBasePath: '/',
          showLastUpdateTime: true,
        },
        blog: {
          showReadingTime: true,
          editUrl: 'https://github.com/ghitatruongle/GHITA-AGENT/edit/main/docs/',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'GHITA',
      logo: {
        alt: 'GHITA Logo',
        src: 'img/logo_official.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'mainSidebar',
          position: 'left',
          label: 'Docs',
        },
        { type: 'docSidebar', sidebarId: 'apiSidebar', position: 'left', label: 'API' },
        { to: '/blog', label: 'Blog', position: 'left' },
        {
          href: 'https://github.com/ghitatruongle/GHITA-AGENT',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/getting-started' },
            { label: 'Architecture', to: '/architecture' },
            { label: 'Tutorials', to: '/tutorials/first-agent' },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Discussions',
              href: 'https://github.com/ghitatruongle/GHITA-AGENT/discussions',
            },
            { label: 'Issues', href: 'https://github.com/ghitatruongle/GHITA-AGENT/issues' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'Blog', to: '/blog' },
            { label: 'Contributing', to: '/contributing' },
            { label: 'Changelog', to: '/changelog' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} GHITA. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['typescript', 'bash', 'json', 'rust'],
    },
    algolia: {
      appId: 'PLACEHOLDER_APP_ID',
      apiKey: 'PLACEHOLDER_SEARCH_KEY',
      indexName: 'ghita',
      contextualSearch: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
