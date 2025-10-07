declare const Buffer: {
  from(input: string, encoding?: string): { toString(encoding?: string): string };
  byteLength(input: string): number;
};

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
};

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

declare module 'fs' {
  export const promises: {
    readFile(path: string, options?: string): Promise<any>;
    writeFile(path: string, data: any, options?: string): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean }>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  };
}

declare module 'path' {
  export function join(...segments: string[]): string;
  export function resolve(...segments: string[]): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function normalize(path: string): string;
}

declare module 'http' {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string | number>): void;
    end(data?: any): void;
  }

  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

  export interface Server {
    listen(port: number, callback?: () => void): void;
  }

  export function createServer(listener: RequestListener): Server;
}
