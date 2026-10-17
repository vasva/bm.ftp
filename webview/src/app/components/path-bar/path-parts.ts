export type PathPane = 'local' | 'remote';

export interface PathPart {
  label: string;
  path: string;
  isRoot: boolean;
  clickable: boolean;
  separatorBefore: boolean;
  ellipsis?: boolean;
}

export function buildPathParts(path: string, pane: PathPane, connected: boolean, visibleFolderCount = 3): PathPart[] {
  if (!path || (pane === 'remote' && !connected)) return [];

  const normalized = path.replace(/\\/g, '/');
  let root = '';
  let remainder = normalized;
  const driveRoot = normalized.match(/^([A-Za-z]:)\//);
  if (driveRoot) {
    root = `${driveRoot[1]}/`;
    remainder = normalized.slice(root.length);
  } else if (pane === 'local' && normalized.startsWith('//')) {
    const segments = normalized.slice(2).split('/').filter(Boolean);
    if (segments.length >= 2) {
      root = `//${segments[0]}/${segments[1]}/`;
      remainder = segments.slice(2).join('/');
    }
  } else if (normalized.startsWith('/')) {
    root = '/';
    remainder = normalized.slice(1);
  }

  const folders = remainder.split('/').filter(Boolean);
  const parts: PathPart[] = root ? [{ label: root, path: root, isRoot: true, clickable: true, separatorBefore: false }] : [];
  let currentPath = root;
  folders.forEach((folder, index) => {
    currentPath = currentPath
      ? `${currentPath.endsWith('/') ? currentPath : `${currentPath}/`}${folder}`
      : folder;
    const previousPart = parts.at(-1);
    parts.push({
      label: folder,
      path: currentPath,
      isRoot: false,
      clickable: index < folders.length - 1,
      separatorBefore: Boolean(previousPart && !previousPart.isRoot)
    });
  });

  if (folders.length <= visibleFolderCount) return parts;
  const rootPart = parts.find((part) => part.isRoot);
  const tail = parts.slice(-visibleFolderCount).map((part) => ({ ...part, separatorBefore: true }));
  const ellipsis: PathPart = {
    label: '…',
    path: `${normalized}#ellipsis`,
    isRoot: false,
    clickable: false,
    separatorBefore: false,
    ellipsis: true
  };
  return [...(rootPart ? [rootPart] : []), ellipsis, ...tail];
}
