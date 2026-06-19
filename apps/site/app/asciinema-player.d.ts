declare module "asciinema-player" {
  export interface CreateOptions {
    autoplay?: boolean;
    loop?: boolean;
    speed?: number;
    idleTimeLimit?: number;
    terminalFontSize?: string;
    theme?: string;
    fit?: string | boolean;
    controls?: boolean | "auto";
    [key: string]: unknown;
  }
  export interface PlayerHandle {
    play?: () => void;
    pause?: () => void;
    dispose?: () => void;
  }
  /**
   * Minimal typing for the asciinema-player `create` entrypoint. The package
   * ships no bundled types; this declaration covers the options used by
   * AsciinemaPlayer.tsx.
   */
  export function create(
    src: string,
    element: HTMLElement,
    options?: CreateOptions,
  ): PlayerHandle;
}
