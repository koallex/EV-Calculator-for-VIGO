/** Single source of truth: package.json "version" (injected at build time by vite.config.ts). */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
