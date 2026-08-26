/**
 * Tampermonkey GM_* API ambient type declarations
 */

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;
declare function GM_deleteValue(key: string): void;

interface GMXMLHttpRequestOptions {
  method: "GET" | "POST" | "HEAD" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  onload?: (response: {
    status: number;
    statusText: string;
    responseText: string;
    responseHeaders: string;
  }) => void;
  onerror?: (err: any) => void;
  ontimeout?: () => void;
}

declare function GM_xmlhttpRequest(options: GMXMLHttpRequestOptions): void;
