import { Injectable } from '@angular/core';
import type { FileEntry } from '../components/file-view/file-view.component';
import { FileSelectionMode, reconcileSelection, SelectionState, updateSelection } from '../selection';

export type Pane = 'local' | 'remote';

@Injectable({ providedIn: 'root' })
export class SelectionService {
  private readonly states: Record<Pane, SelectionState> = {
    local: { paths: [], anchorPath: '' },
    remote: { paths: [], anchorPath: '' }
  };

  get(pane: Pane): string[] {
    return this.states[pane].paths;
  }

  set(pane: Pane, paths: string[], anchorPath = ''): void {
    this.states[pane] = { paths, anchorPath };
  }

  anchor(pane: Pane): string {
    return this.states[pane].anchorPath;
  }

  select(pane: Pane, entries: FileEntry[], targetPath: string, mode: FileSelectionMode): void {
    const state = this.states[pane];
    this.states[pane] = updateSelection(entries, state.paths, state.anchorPath, targetPath, mode);
  }

  reconcile(pane: Pane, entries: FileEntry[]): string[] {
    const state = this.states[pane];
    const paths = reconcileSelection(entries, state.paths);
    const anchorPath = entries.some((entry) => entry.path === state.anchorPath)
      ? state.anchorPath
      : paths.at(-1) ?? '';
    this.states[pane] = { paths, anchorPath };
    return paths;
  }
}
