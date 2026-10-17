export interface SelectableFile {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export type FileSelectionMode = 'replace' | 'toggle' | 'range' | 'add-range';

export interface SelectionState {
  paths: string[];
  anchorPath: string;
}

export function selectionModeForModifiers(modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): FileSelectionMode {
  if (modifiers.shiftKey) return modifiers.ctrlKey || modifiers.metaKey ? 'add-range' : 'range';
  return modifiers.ctrlKey || modifiers.metaKey ? 'toggle' : 'replace';
}

export function isSelectionToggleKey(key: string): boolean {
  return key === 'Insert' || key === ' ';
}

export function updateSelection(
  entries: SelectableFile[],
  selectedPaths: string[],
  anchorPath: string,
  targetPath: string,
  mode: FileSelectionMode
): SelectionState {
  const targetIndex = entries.findIndex((entry) => entry.path === targetPath);
  if (targetIndex < 0) return { paths: reconcileSelection(entries, selectedPaths), anchorPath: '' };

  if (mode === 'toggle') {
    const paths = selectedPaths.includes(targetPath)
      ? selectedPaths.filter((path) => path !== targetPath)
      : [...selectedPaths, targetPath];
    return { paths: reconcileSelection(entries, paths), anchorPath: targetPath };
  }

  if (mode === 'range' || mode === 'add-range') {
    const anchorIndex = entries.findIndex((entry) => entry.path === anchorPath);
    if (anchorIndex < 0) return { paths: [targetPath], anchorPath: targetPath };
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangePaths = entries.slice(start, end + 1).map((entry) => entry.path);
    const paths = mode === 'add-range' ? [...new Set([...selectedPaths, ...rangePaths])] : rangePaths;
    return { paths: reconcileSelection(entries, paths), anchorPath };
  }

  return { paths: [targetPath], anchorPath: targetPath };
}

export function reconcileSelection(entries: SelectableFile[], selectedPaths: string[]): string[] {
  const visiblePaths = new Set(entries.map((entry) => entry.path));
  return selectedPaths.filter((path, index) => visiblePaths.has(path) && selectedPaths.indexOf(path) === index);
}

export function hasVisibleFileSelection(entries: SelectableFile[], selectedPath: string, query: string): boolean {
  const search = query.trim().toLocaleLowerCase();
  return entries.some((entry) => entry.path === selectedPath && entry.kind === 'file' && entry.name.toLocaleLowerCase().includes(search));
}
