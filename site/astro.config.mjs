// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const fontHead = [
  // Default to the light theme unless the visitor has explicitly chosen one.
  {
    tag: 'script',
    content:
      "if(!localStorage.getItem('starlight-theme')){localStorage.setItem('starlight-theme','light');document.documentElement.dataset.theme='light';}",
  },
  { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
  { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
  {
    tag: 'link',
    attrs: {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
    },
  },
];

// dev-only element grabber (inert in production builds)
const isDev = process.env.NODE_ENV !== 'production';
const head = isDev ? [{ tag: 'script', attrs: { src: '/dev-grab.js' } }, ...fontHead] : fontHead;

export default defineConfig({
  site: 'https://agent-presence.vercel.app',
  integrations: [
    starlight({
      title: 'agent-presence',
      description: 'Sync local coding-agent presence and token usage to your Feishu signature.',
      logo: { src: './src/assets/brand-icon.svg' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/global.css'],
      head,
      components: {
        ThemeSelect: './src/components/ThemeSelect.astro',
        LanguageSelect: './src/components/LanguageSelect.astro',
      },
      expressiveCode: {
        themes: ['github-light', 'github-dark'],
        // Use the editor "code" frame (clean panel, no terminal dots/titlebar)
        // instead of the terminal window chrome shell blocks default to.
        defaultProps: { frame: 'code' },
        styleOverrides: {
          borderRadius: '12px',
          borderColor: 'var(--sl-color-hairline)',
          borderWidth: '1px',
          codeBackground: 'var(--sl-color-bg-inline-code)',
          codeFontFamily: 'var(--ap-font-mono)',
          codeFontSize: '13.5px',
          codeLineHeight: '1.7',
          codePaddingBlock: '0.95rem',
          codePaddingInline: '1.15rem',
          frames: {
            editorActiveTabIndicatorTopColor: 'transparent',
            editorTabBarBackground: 'transparent',
            shadowColor: 'transparent',
          },
        },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/PerfectPan/agent-presence' },
      ],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        zh: { label: '简体中文', lang: 'zh-CN' },
      },
      sidebar: [
        {
          label: 'Guide',
          translations: { 'zh-CN': '指南' },
          items: [
            { label: 'Install', translations: { 'zh-CN': '安装' }, slug: 'guide/install' },
            { label: 'Quick start', translations: { 'zh-CN': '快速上手' }, slug: 'guide/quick-start' },
            { label: 'Providers', translations: { 'zh-CN': 'Provider' }, slug: 'guide/providers' },
            { label: 'Sources', translations: { 'zh-CN': 'Sources' }, slug: 'guide/sources' },
            { label: 'Token usage', translations: { 'zh-CN': 'Token 统计' }, slug: 'guide/token-usage' },
            { label: 'Presence semantics', translations: { 'zh-CN': 'Presence 语义' }, slug: 'guide/presence' },
          ],
        },
        {
          label: 'Reference',
          translations: { 'zh-CN': '参考' },
          items: [{ label: 'Commands', translations: { 'zh-CN': '命令' }, slug: 'reference/commands' }],
        },
        {
          label: 'Project',
          translations: { 'zh-CN': '项目' },
          items: [
            { label: 'Architecture', translations: { 'zh-CN': '架构' }, slug: 'project/architecture' },
            { label: 'Brand', translations: { 'zh-CN': '品牌' }, slug: 'project/brand' },
          ],
        },
      ],
    }),
  ],
});
