import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { selectionModeForModifiers } from '../../selection';
import { SelectionService } from '../../services/selection.service';
import type { Pane } from '../../services/selection.service';
import { FileContextMenuComponent } from '../file-context-menu/file-context-menu.component';

export type FileViewPane = Pane;
export type SortColumn = 'name' | 'size' | 'modified';
export type SortDirection = 'ascending' | 'descending';

export interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modified?: string;
  modifiedTime?: number;
  relativePath?: string;
}

@Component({
  selector: 'bm-file-view',
  standalone: true,
  imports: [FileContextMenuComponent],
  templateUrl: './file-view.component.html',
  styleUrl: './file-view.component.css'
})
export class FileViewComponent implements OnChanges, AfterViewInit {
  @Input({ required: true }) pane!: FileViewPane;
  @Input() directoryPath = '';
  @Input() entries: FileEntry[] = [];
  @Input() selectedPaths: string[] = [];
  @Input() search = '';
  @Input() sort: SortState = { column: 'name', direction: 'ascending' };
  @Input() connected = false;

  @Output() searchChanged = new EventEmitter<string>();
  @Output() sortChanged = new EventEmitter<SortColumn>();
  @Output() itemActionRequested = new EventEmitter<{ entry: FileEntry; open: boolean }>();
  @Output() copyPathRequested = new EventEmitter<{ pane: Pane; path: string; relative: boolean }>();
  @Output() paneActivated = new EventEmitter<void>();

  @ViewChild('fileList') private fileList?: ElementRef<HTMLElement>;
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  contextMenu?: { entry: FileEntry; x: number; y: number };

  constructor(private readonly selection: SelectionService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['directoryPath'] && !changes['directoryPath'].firstChange) this.scrollToTop();
  }

  ngAfterViewInit(): void {
    this.scrollToTop();
  }

  focusSearch(): void {
    this.searchInput?.nativeElement.focus();
  }

  activateEntry(entry: FileEntry, event: MouseEvent, open: boolean): void {
    this.paneActivated.emit();
    if (open) {
      this.selection.set(this.pane, [entry.path], entry.path);
      this.itemActionRequested.emit({ entry, open: true });
      return;
    }

    const mode = selectionModeForModifiers({ shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    this.selection.select(this.pane, this.entries, entry.path, mode);
  }

  handleRowKeydown(entry: FileEntry, event: KeyboardEvent): void {
    this.paneActivated.emit();
    const index = this.entries.findIndex((candidate) => candidate.path === entry.path);

    if ((event.key === 'Insert' || event.key === ' ') && !event.repeat) {
      event.preventDefault();
      this.selection.select(this.pane, this.entries, entry.path, 'toggle');
      if (event.key === 'Insert') this.focusRow(event.currentTarget, 1);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      this.selection.set(this.pane, [entry.path], entry.path);
      this.itemActionRequested.emit({ entry, open: true });
      return;
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const target = this.entries[index + direction];
    if (!target) return;
    if (event.shiftKey) {
      if (!this.selection.anchor(this.pane)) this.selection.set(this.pane, this.selectedPaths, entry.path);
      const mode = selectionModeForModifiers({ shiftKey: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
      this.selection.select(this.pane, this.entries, target.path, mode);
    }
    this.focusRow(event.currentTarget, direction);
  }

  handleListKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.paneActivated.emit();
      const paths = this.entries.map((entry) => entry.path);
      this.selection.set(this.pane, paths, paths[0] ?? '');
    }
  }

  openContextMenu(entry: FileEntry, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const width = 220;
    const height = this.pane === 'remote' ? 44 : 80;
    this.contextMenu = {
      entry,
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - height - 4))
    };
  }

  copyContextPath(entry: FileEntry, relative: boolean): void {
    this.copyPathRequested.emit({ pane: this.pane, path: entry.path, relative });
    this.contextMenu = undefined;
  }

  get noEntriesMessage(): string {
    if (this.pane === 'remote' && !this.connected) return 'Connect to view the remote directory.';
    if (this.search) return 'No matching files or folders.';
    return 'No files in this folder.';
  }

  sortLabel(column: SortColumn, label: string): string {
    if (this.sort.column !== column) return `${label}, not sorted`;
    return `${label}, sorted ${this.sort.direction}`;
  }

  sortIcon(column: SortColumn): string {
    if (this.sort.column !== column) return '';
    return this.sort.direction === 'ascending' ? 'arrow_upward' : 'arrow_downward';
  }

  formatSize(size: number, kind: FileEntry['kind']): string {
    if (kind === 'directory') return '<DIR>';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  private scrollToTop(): void {
    if (this.fileList) this.fileList.nativeElement.scrollTop = 0;
  }

  private focusRow(currentTarget: EventTarget | null, direction: number): void {
    if (!(currentTarget instanceof HTMLButtonElement)) return;
    const rows = Array.from(currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.file-row') ?? []);
    const index = rows.indexOf(currentTarget);
    rows[index + direction]?.focus();
  }

  dismissContextMenu(): void {
    this.contextMenu = undefined;
  }
}
