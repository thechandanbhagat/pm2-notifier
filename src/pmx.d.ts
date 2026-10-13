declare module 'pmx' {
  export function initModule(options: Record<string, unknown>, callback: (error: Error | null, config: Record<string, unknown>) => void): void;
}
