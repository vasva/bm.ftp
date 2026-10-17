import { Injectable } from '@angular/core';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

@Injectable({ providedIn: 'root' })
export class WebviewBridgeService {
  private readonly vscode = acquireVsCodeApi();

  postMessage(message: unknown): void {
    this.vscode.postMessage(message);
  }

  listen<T>(handler: (message: T) => void): () => void {
    const listener = (event: MessageEvent<T>) => handler(event.data);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }
}
