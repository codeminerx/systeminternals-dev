import { defineConfig } from 'astro/config';

import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://systeminternals.dev',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'tokyo-night',
    },
  },
});
