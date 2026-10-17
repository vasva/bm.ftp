import { Injectable } from '@angular/core';
import type { Pane } from './selection.service';

export interface CopyRequest {
  type: 'copy';
  source: Pane;
  paths: string[];
}

@Injectable({ providedIn: 'root' })
export class CopyService {
  canCopy(connected: boolean, busy: boolean, selectedPaths: string[], visiblePaths: string[]): boolean {
    if (!connected || busy || selectedPaths.length === 0) return false;
    const visible = new Set(visiblePaths);
    return selectedPaths.every((path) => visible.has(path));
  }

  createRequest(source: Pane, selectedPaths: string[]): CopyRequest | undefined {
    if (selectedPaths.length === 0) return undefined;
    return { type: 'copy', source, paths: [...selectedPaths] };
  }
}
