import { Injectable } from '@angular/core';
import type { FileEntry, SortColumn, SortState } from '../components/file-view/file-view.component';

@Injectable({ providedIn: 'root' })
export class FileListService {
  filterAndSort(entries: FileEntry[], query: string, sort: SortState): FileEntry[] {
    const search = query.trim().toLocaleLowerCase();
    const filtered = search ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search)) : entries;
    return [...filtered].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

      let comparison = 0;
      if (sort.column === 'name') comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (sort.column === 'size') comparison = a.size - b.size;
      if (sort.column === 'modified') {
        const aTime = a.modifiedTime ?? Number.NEGATIVE_INFINITY;
        const bTime = b.modifiedTime ?? Number.NEGATIVE_INFINITY;
        comparison = aTime === bTime ? 0 : aTime < bTime ? -1 : 1;
      }
      if (comparison === 0 && sort.column !== 'name') comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return sort.direction === 'ascending' ? comparison : -comparison;
    });
  }

  toggleSort(current: SortState, column: SortColumn): SortState {
    return {
      column,
      direction: current.column === column && current.direction === 'ascending' ? 'descending' : 'ascending'
    };
  }
}
