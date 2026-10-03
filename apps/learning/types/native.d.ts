import type { NativeBridge } from '@sew/study-contracts';

declare global {
  interface Window {
    /** 由 Electron preload 注入的唯一桥接对象；浏览器直开时为 undefined。 */
    sewNative?: NativeBridge;
  }
}

export {};
