import { ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommanderFooterComponent } from './components/commander-footer/commander-footer.component';
import { ConnectionBarComponent } from './components/connection-bar/connection-bar.component';
import { formatForgetConnectionMessage, sameConnectionProfile } from './connection-profile';
import type { ConnectionProfile } from './connection-profile';
import { CopyProgressComponent } from './components/copy-progress/copy-progress.component';
import type { CopyProgress } from './components/copy-progress/copy-progress.component';
import { ConfirmationDialogComponent } from './components/confirmation-dialog/confirmation-dialog.component';
import { ErrorDialogComponent } from './components/error-dialog/error-dialog.component';
import type { FileEntry, SortColumn, SortState } from './components/file-view/file-view.component';
import { FilePaneComponent } from './components/file-pane/file-pane.component';
import { hasVisibleFileSelection } from './selection';
import { CopyService } from './services/copy.service';
import { FileListService } from './services/file-list.service';
import { Pane, SelectionService } from './services/selection.service';
import { WebviewBridgeService } from './services/webview-bridge.service';
import { blockBackgroundKeydown } from './modal-keyboard';

interface HostMessage {
  type: string;
  operation?: string;
  localPath?: string;
  remotePath?: string;
  localEntries?: FileEntry[];
  remoteEntries?: FileEntry[];
  profile?: Partial<ConnectionProfile>;
  savedProfiles?: ConnectionProfile[];
  logoUrl?: string;
  connected?: boolean;
  error?: string;
  transfer?: string;
  progress?: CopyProgress | null;
}

@Component({
  selector: 'bm-root',
  standalone: true,
  imports: [CommanderFooterComponent, ConnectionBarComponent, CopyProgressComponent, ConfirmationDialogComponent, ErrorDialogComponent, FilePaneComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  constructor(
    private readonly changeDetector: ChangeDetectorRef,
    private readonly selection: SelectionService,
    private readonly copy: CopyService,
    private readonly fileList: FileListService,
    private readonly bridge: WebviewBridgeService
  ) {}

  @ViewChild('localPane') private localPane?: FilePaneComponent;
  @ViewChild('remotePane') private remotePane?: FilePaneComponent;
  private removeMessageListener?: () => void;
  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (blockBackgroundKeydown(this.modalOpen, event)) return;
    if (!isEditableTarget(event.target)) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        (this.activePane === 'local' ? this.localPane : this.remotePane)?.focusSearch();
      }
    }
    if (event.key === 'Tab' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement) && !(event.target instanceof HTMLButtonElement)) {
      this.activePane = this.activePane === 'local' ? 'remote' : 'local';
      event.preventDefault();
      this.changeDetector.detectChanges();
    }
  };

  profile: ConnectionProfile = { host: '', port: 21, username: '', protocol: 'ftps' };
  savedProfiles: ConnectionProfile[] = [];
  logoUrl = '';
  password = '';
  localPath = '';
  remotePath = '/';
  localEntries: FileEntry[] = [];
  remoteEntries: FileEntry[] = [];
  localSort: SortState = { column: 'name', direction: 'ascending' };
  remoteSort: SortState = { column: 'name', direction: 'ascending' };
  localSearch = '';
  remoteSearch = '';
  localLoading = true;
  remoteLoading = false;
  get localSelection(): string[] { return this.selection.get('local'); }
  get remoteSelection(): string[] { return this.selection.get('remote'); }
  activePane: Pane = 'local';
  connected = false;
  busy = false;
  status = 'Choose a server to connect.';
  error = '';
  errorTitle = '';
  errorMessage = '';
  errorHint = '';
  copyProgress: CopyProgress | null = null;
  forgetConfirmationProfile: ConnectionProfile | null = null;
  forgetRequestPending = false;

  get modalOpen(): boolean {
    return Boolean(this.errorMessage || this.copyProgress || this.forgetConfirmationProfile);
  }

  get filteredLocalEntries(): FileEntry[] {
    return this.fileList.filterAndSort(this.localEntries, this.localSearch, this.localSort);
  }

  get filteredRemoteEntries(): FileEntry[] {
    return this.fileList.filterAndSort(this.remoteEntries, this.remoteSearch, this.remoteSort);
  }

  toggleSort(pane: Pane, column: SortColumn): void {
    const current = pane === 'local' ? this.localSort : this.remoteSort;
    const next = this.fileList.toggleSort(current, column);
    if (pane === 'local') this.localSort = next;
    else this.remoteSort = next;
  }

  ngOnInit(): void {
    this.removeMessageListener = this.bridge.listen<HostMessage>((message) => this.receive(message));
    window.addEventListener('keydown', this.handleKeydown);
    this.bridge.postMessage({ type: 'ready' });
  }

  ngOnDestroy(): void {
    this.removeMessageListener?.();
    window.removeEventListener('keydown', this.handleKeydown);
  }

  updateProfile(profile: ConnectionProfile): void {
    const changed = profile.host !== this.profile.host || profile.port !== this.profile.port
      || profile.username !== this.profile.username || profile.protocol !== this.profile.protocol;
    if (changed && this.savedProfiles.some((saved) => sameConnectionProfile(saved, this.profile))) this.password = '';
    this.profile = profile;
  }

  selectSavedProfile(profile: ConnectionProfile): void {
    this.profile = profile;
    this.password = '';
  }

  forgetSavedProfile(profile: ConnectionProfile): void {
    this.forgetConfirmationProfile = profile;
  }

  cancelForgetSavedProfile(): void {
    this.forgetConfirmationProfile = null;
  }

  confirmForgetSavedProfile(): void {
    const profile = this.forgetConfirmationProfile;
    if (!profile || this.forgetRequestPending) return;
    this.forgetConfirmationProfile = null;
    this.forgetRequestPending = true;
    this.bridge.postMessage({ type: 'forget-connection', profile });
  }

  forgetConfirmationMessage(profile: ConnectionProfile): string {
    return formatForgetConnectionMessage(profile);
  }

  dismissError(): void {
    this.errorMessage = '';
  }

  connect(): void {
    this.error = '';
    this.busy = true;
    this.remoteLoading = true;
    this.status = 'Connecting…';
    this.bridge.postMessage({ type: 'connect', profile: this.profile, password: this.password });
  }

  disconnect(): void {
    this.error = '';
    this.bridge.postMessage({ type: 'disconnect' });
  }

  refresh(pane: Pane): void {
    this.error = '';
    this.setLoading(pane);
    this.bridge.postMessage({ type: 'refresh', pane });
  }

  navigate(pane: Pane, path: string): void {
    this.error = '';
    this.activePane = pane;
    this.setSelection(pane, [], '');
    this.setLoading(pane);
    this.bridge.postMessage({ type: 'navigate', pane, path });
  }

  parent(pane: Pane): void {
    this.error = '';
    this.activePane = pane;
    this.setSelection(pane, [], '');
    this.setLoading(pane);
    this.bridge.postMessage({ type: 'parent', pane });
  }

  canOpen(pane: Pane): boolean {
    const selection = this.getSelection(pane);
    if (selection.length !== 1) return false;
    const selected = selection[0];
    return this.hasVisibleFileSelection(pane, selected);
  }

  canCopy(pane: Pane): boolean {
    return this.copy.canCopy(this.connected, this.busy, this.getSelection(pane), this.filteredEntries(pane).map((entry) => entry.path));
  }

  canDelete(pane: Pane): boolean {
    if (this.busy || (pane === 'remote' && !this.connected)) return false;
    const selectedPaths = this.getSelection(pane);
    const visiblePaths = new Set(this.filteredEntries(pane).map((entry) => entry.path));
    return selectedPaths.length > 0 && selectedPaths.every((path) => visiblePaths.has(path));
  }

  updateSearch(pane: Pane, value: string): void {
    if (pane === 'local') this.localSearch = value;
    else this.remoteSearch = value;
    this.reconcilePaneSelection(pane);
  }

  openSelected(pane: Pane): void {
    const selected = this.getSelection(pane)[0];
    if (!this.canOpen(pane)) return;
    this.error = '';
    this.activePane = pane;
    this.bridge.postMessage({ type: 'open-file', pane, path: selected });
  }

  createFolder(pane: Pane): void {
    if (pane === 'remote' && !this.connected) return;
    this.error = '';
    this.activePane = pane;
    this.bridge.postMessage({ type: 'create-folder', pane });
  }

  handleFileAction(pane: Pane, entry: FileEntry, open: boolean): void {
    if (!open) return;
    this.error = '';
    this.activePane = pane;
    if (entry.kind === 'directory') this.navigate(pane, entry.path);
    else this.bridge.postMessage({ type: 'open-file', pane, path: entry.path });
  }

  copySelected(): void {
    const source = this.activePane;
    const selected = [...this.getSelection(source)];
    const request = this.copy.createRequest(source, selected);
    if (!request || !this.canCopy(source)) return;
    this.error = '';
    this.busy = true;
    this.status = `Copying ${selected.length} item${selected.length === 1 ? '' : 's'}…`;
    this.bridge.postMessage(request);
  }

  deleteSelected(): void {
    const pane = this.activePane;
    if (!this.canDelete(pane)) return;
    const paths = [...this.getSelection(pane)];
    this.error = '';
    this.busy = true;
    this.status = 'Waiting for delete confirmation…';
    this.bridge.postMessage({ type: 'delete', pane, paths });
  }

  copyPath(pane: Pane, path: string, relative: boolean): void {
    this.error = '';
    this.bridge.postMessage({ type: 'copy-path', pane, path, relative });
  }

  private receive(message: HostMessage): void {
    if (message.progress !== undefined) this.copyProgress = message.progress;
    if (message.savedProfiles !== undefined) {
      this.savedProfiles = message.savedProfiles;
      this.forgetRequestPending = false;
    }
    if (message.logoUrl !== undefined) this.logoUrl = message.logoUrl;
    if (message.localPath !== undefined) this.localPath = message.localPath;
    if (message.remotePath !== undefined) this.remotePath = message.remotePath;
    if (message.localEntries !== undefined) {
      this.localEntries = message.localEntries;
      this.localLoading = false;
      this.reconcilePaneSelection('local');
    }
    if (message.remoteEntries !== undefined) {
      this.remoteEntries = message.remoteEntries;
      this.remoteLoading = false;
      this.reconcilePaneSelection('remote');
    }
    if (message.profile) {
      this.profile = {
        host: message.profile.host ?? this.profile.host,
        port: message.profile.port ?? this.profile.port,
        username: message.profile.username ?? this.profile.username,
        protocol: message.profile.protocol ?? this.profile.protocol
      };
    }
    if (message.connected !== undefined) this.connected = message.connected;
    if (message.error) {
      if (message.operation === 'forget-connection') this.forgetRequestPending = false;
      this.error = message.error;
      this.errorTitle = errorTitleFor(message.operation);
      this.errorMessage = message.error;
      this.errorHint = errorHintFor(message.operation);
      this.copyProgress = null;
    }
    if (message.error) {
      this.localLoading = false;
      this.remoteLoading = false;
    }
    if (this.error) this.status = 'Connection or file operation failed.';
    else if (message.transfer) this.status = message.transfer;
    else if (message.connected !== undefined) this.status = this.connected ? 'Connected.' : 'Choose a server to connect.';
    if (message.connected !== undefined || message.error || message.transfer) this.busy = false;
    this.changeDetector.detectChanges();
  }

  private filteredEntries(pane: Pane): FileEntry[] {
    return pane === 'local' ? this.filteredLocalEntries : this.filteredRemoteEntries;
  }

  private getSelection(pane: Pane): string[] {
    return this.selection.get(pane);
  }

  private reconcilePaneSelection(pane: Pane): void {
    this.selection.reconcile(pane, this.filteredEntries(pane));
  }

  private hasVisibleFileSelection(pane: Pane, selectedPath: string): boolean {
    if (!selectedPath) return false;
    const entries = pane === 'local' ? this.localEntries : this.remoteEntries;
    const query = pane === 'local' ? this.localSearch : this.remoteSearch;
    return hasVisibleFileSelection(entries, selectedPath, query);
  }

  private setSelection(pane: Pane, selected: string[], anchorPath: string): void {
    this.selection.set(pane, selected, anchorPath);
  }

  private setLoading(pane: Pane): void {
    if (pane === 'local') this.localLoading = true;
    else this.remoteLoading = true;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null);
}

function errorTitleFor(operation?: string): string {
  switch (operation) {
    case 'connect': return 'Server connection failed';
    case 'forget-connection': return 'Could not forget saved connection';
    case 'copy': return 'Copy failed';
    case 'delete': return 'Delete failed';
    case 'create-folder': return 'Could not create folder';
    case 'open-file': return 'Could not open file';
    case 'copy-path': return 'Could not copy path';
    case 'navigate':
    case 'parent': return 'Could not open folder';
    case 'local-listing': return 'Could not read the local folder';
    case 'remote-listing': return 'Could not read the remote folder';
    case 'refresh': return 'Could not refresh the folder';
    default: return 'Operation failed';
  }
}

function errorHintFor(operation?: string): string {
  switch (operation) {
    case 'connect': return 'Check the server address, port, username, password, and selected protocol.';
    case 'navigate':
    case 'parent':
    case 'local-listing': return 'Check that the folder exists and that you have permission to access it.';
    case 'remote-listing':
    case 'refresh': return 'Check your connection and the folder permissions, then try again.';
    case 'copy': return 'If this was a multi-item copy, earlier items may already have completed. Check the destination before retrying.';
    default: return '';
  }
}
