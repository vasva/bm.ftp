import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';

type Pane = 'local' | 'remote';
type EntryKind = 'file' | 'directory';

interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  modified?: string;
}

interface ConnectionProfile {
  host: string;
  port: number;
  username: string;
  protocol: 'ftp' | 'ftps';
}

interface HostMessage {
  type: string;
  localPath?: string;
  remotePath?: string;
  localEntries?: FileEntry[];
  remoteEntries?: FileEntry[];
  profile?: Partial<ConnectionProfile>;
  connected?: boolean;
  error?: string;
  transfer?: string;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

@Component({
  selector: 'bm-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  constructor(private readonly changeDetector: ChangeDetectorRef) {}

  private readonly vscode = acquireVsCodeApi();
  private readonly handleMessage = (event: MessageEvent<HostMessage>) => this.receive(event.data);
  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'F3') {
      event.preventDefault();
      this.openSelected(this.activePane);
    } else if (event.key === 'F5') {
      event.preventDefault();
      this.copySelected();
    } else if (event.key === 'F7') {
      event.preventDefault();
      this.createFolder(this.activePane);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      document.getElementById(`${this.activePane}-search`)?.focus();
    } else if (event.key === 'Tab' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement) && !(event.target instanceof HTMLButtonElement)) {
      this.activePane = this.activePane === 'local' ? 'remote' : 'local';
      event.preventDefault();
    }
  };

  profile: ConnectionProfile = { host: '', port: 21, username: '', protocol: 'ftps' };
  password = '';
  localPath = '';
  remotePath = '/';
  localEntries: FileEntry[] = [];
  remoteEntries: FileEntry[] = [];
  localSearch = '';
  remoteSearch = '';
  localLoading = true;
  remoteLoading = false;
  localSelection = '';
  remoteSelection = '';
  activePane: Pane = 'local';
  connected = false;
  busy = false;
  status = 'Choose an FTP server to connect.';
  error = '';

  get filteredLocalEntries(): FileEntry[] {
    return this.filterEntries(this.localEntries, this.localSearch);
  }

  get filteredRemoteEntries(): FileEntry[] {
    return this.filterEntries(this.remoteEntries, this.remoteSearch);
  }

  ngOnInit(): void {
    window.addEventListener('message', this.handleMessage);
    window.addEventListener('keydown', this.handleKeydown);
    this.vscode.postMessage({ type: 'ready' });
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.handleMessage);
    window.removeEventListener('keydown', this.handleKeydown);
  }

  updateProfile(field: keyof ConnectionProfile, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (field === 'port') {
      this.profile.port = Number(value) || 21;
    } else if (field === 'protocol') {
      this.profile.protocol = value === 'ftp' ? 'ftp' : 'ftps';
    } else if (field === 'host') {
      this.profile.host = value;
    } else {
      this.profile.username = value;
    }
  }

  connect(): void {
    this.error = '';
    this.busy = true;
    this.remoteLoading = true;
    this.status = 'Connecting…';
    this.vscode.postMessage({ type: 'connect', profile: this.profile, password: this.password });
  }

  disconnect(): void {
    this.vscode.postMessage({ type: 'disconnect' });
  }

  refresh(): void {
    this.localLoading = true;
    this.remoteLoading = true;
    this.vscode.postMessage({ type: 'refresh' });
  }

  navigate(pane: Pane, path: string): void {
    this.activePane = pane;
    this.setLoading(pane);
    this.vscode.postMessage({ type: 'navigate', pane, path });
  }

  parent(pane: Pane): void {
    this.activePane = pane;
    this.setLoading(pane);
    this.vscode.postMessage({ type: 'parent', pane });
  }

  select(pane: Pane, entry: FileEntry, open: boolean): void {
    this.activePane = pane;
    if (pane === 'local') {
      this.localSelection = entry.path;
    } else {
      this.remoteSelection = entry.path;
    }
    if (open) {
      if (entry.kind === 'directory') this.navigate(pane, entry.path);
      else this.vscode.postMessage({ type: 'open-file', pane, path: entry.path });
    }
  }

  canOpen(pane: Pane): boolean {
    const selected = pane === 'local' ? this.localSelection : this.remoteSelection;
    const entries = pane === 'local' ? this.localEntries : this.remoteEntries;
    return entries.some((entry) => entry.path === selected && entry.kind === 'file');
  }

  openSelected(pane: Pane): void {
    const selected = pane === 'local' ? this.localSelection : this.remoteSelection;
    if (!this.canOpen(pane)) return;
    this.activePane = pane;
    this.vscode.postMessage({ type: 'open-file', pane, path: selected });
  }

  createFolder(pane: Pane): void {
    if (pane === 'remote' && !this.connected) return;
    this.activePane = pane;
    this.vscode.postMessage({ type: 'create-folder', pane });
  }

  copySelected(): void {
    const source = this.activePane;
    const selected = source === 'local' ? this.localSelection : this.remoteSelection;
    if (!selected || !this.connected || this.busy) return;
    this.busy = true;
    this.status = source === 'local' ? 'Uploading…' : 'Downloading…';
    this.vscode.postMessage({ type: 'copy', source, path: selected });
  }

  formatSize(size: number, kind: EntryKind): string {
    if (kind === 'directory') return '<DIR>';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  private receive(message: HostMessage): void {
    if (message.localPath !== undefined) this.localPath = message.localPath;
    if (message.remotePath !== undefined) this.remotePath = message.remotePath;
    if (message.localEntries !== undefined) {
      this.localEntries = message.localEntries;
      this.localLoading = false;
    }
    if (message.remoteEntries !== undefined) {
      this.remoteEntries = message.remoteEntries;
      this.remoteLoading = false;
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
    if (message.error) this.error = message.error;
    else if (message.type === 'data') this.error = '';
    if (message.error) {
      this.localLoading = false;
      this.remoteLoading = false;
    }
    if (message.transfer) this.status = message.transfer;
    else if (message.error) this.status = 'Connection or file operation failed.';
    else if (message.connected !== undefined) this.status = this.connected ? 'Connected. F5 copies the selected file.' : 'Choose an FTP server to connect.';
    if (message.connected !== undefined || message.error || message.transfer) this.busy = false;
    this.changeDetector.detectChanges();
  }

  private filterEntries(entries: FileEntry[], query: string): FileEntry[] {
    const search = query.trim().toLocaleLowerCase();
    return search ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search)) : entries;
  }

  private setLoading(pane: Pane): void {
    if (pane === 'local') this.localLoading = true;
    else this.remoteLoading = true;
  }
}
