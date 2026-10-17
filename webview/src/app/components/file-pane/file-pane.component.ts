import { Component, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { FileViewComponent } from '../file-view/file-view.component';
import type { FileEntry, SortColumn, SortState } from '../file-view/file-view.component';
import { PaneHeaderComponent } from '../pane-header/pane-header.component';
import { PathBarComponent } from '../path-bar/path-bar.component';
import type { Pane } from '../../services/selection.service';

@Component({
  selector: 'bm-file-pane',
  standalone: true,
  imports: [FileViewComponent, PaneHeaderComponent, PathBarComponent],
  templateUrl: './file-pane.component.html',
  styleUrl: './file-pane.component.css'
})
export class FilePaneComponent {
  @Input({ required: true }) pane!: Pane;
  @Input() active = false;
  @Input() connected = false;
  @Input() loading = false;
  @Input() path = '';
  @Input() entries: FileEntry[] = [];
  @Input() selectedPaths: string[] = [];
  @Input() search = '';
  @Input() sort: SortState = { column: 'name', direction: 'ascending' };

  @Output() paneActivated = new EventEmitter<Pane>();
  @Output() refreshRequested = new EventEmitter<Pane>();
  @Output() parentRequested = new EventEmitter<Pane>();
  @Output() pathSelected = new EventEmitter<{ pane: Pane; path: string }>();
  @Output() searchChanged = new EventEmitter<{ pane: Pane; value: string }>();
  @Output() sortChanged = new EventEmitter<{ pane: Pane; column: SortColumn }>();
  @Output() itemActionRequested = new EventEmitter<{ pane: Pane; entry: FileEntry; open: boolean }>();
  @Output() copyPathRequested = new EventEmitter<{ pane: Pane; path: string; relative: boolean }>();

  @ViewChild(FileViewComponent) private fileView?: FileViewComponent;

  focusSearch(): void {
    this.fileView?.focusSearch();
  }
}
