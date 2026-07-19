import type { TexerisApi } from '../../shared/ipc-contract';

declare global {
  interface Window {
    texeris: TexerisApi;
  }
}

export {};
