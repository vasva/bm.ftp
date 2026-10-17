import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as posix from 'node:path/posix';
import { PassThrough } from 'node:stream';
import { Client, FileInfo } from 'basic-ftp';

type Pane = 'local' | 'remote';
type Protocol = 'ftp' | 'ftps';

interface ConnectionProfile {
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
}

interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modified?: string;
}

interface PanelMessage {
  type: string;
  pane?: Pane;
  path?: string;
  name?: string;
  source?: Pane;
  password?: string;
  profile?: Partial<ConnectionProfile>;
}

const PROFILE_KEY = 'bm.ftp.profile';
const PASSWORD_KEY = 'bm.ftp.password';

export class CommanderPanel {
  private static current: CommanderPanel | undefined;
  private static readonlyDocuments = new Map<string, { panel: CommanderPanel; path: string; content?: string }>();

  static registerReadonlyDocuments(): vscode.Disposable {
    const readonlyStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    readonlyStatus.text = '$(lock) FTP · Read-only';
    readonlyStatus.tooltip = 'This is a read-only copy opened from an FTP server. Changes cannot be saved to the server.';
    const updateReadonlyStatus = (editor: vscode.TextEditor | undefined): void => {
      if (editor?.document.uri.scheme === 'bm-ftp-readonly') readonlyStatus.show();
      else readonlyStatus.hide();
    };
    updateReadonlyStatus(vscode.window.activeTextEditor);
    const editorListener = vscode.window.onDidChangeActiveTextEditor(updateReadonlyStatus);
    const provider = vscode.workspace.registerTextDocumentContentProvider('bm-ftp-readonly', {
      provideTextDocumentContent: async (uri) => {
        const document = CommanderPanel.readonlyDocuments.get(uri.authority);
        if (!document) throw new Error('The FTP document is no longer available.');
        if (document.content === undefined) document.content = await document.panel.readRemoteFile(document.path);
        return document.content;
      }
    });
    const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === 'bm-ftp-readonly') CommanderPanel.readonlyDocuments.delete(document.uri.authority);
    });
    return vscode.Disposable.from(provider, closeListener, editorListener, readonlyStatus);
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (CommanderPanel.current) {
      CommanderPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'bmFtpCommander',
      'bm.ftp Commander',
      column,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'webview', 'browser')] }
    );
    CommanderPanel.current = new CommanderPanel(panel, context);
  }

  static close(): void {
    CommanderPanel.current?.client.close();
    CommanderPanel.current = undefined;
  }

  private readonly client = new Client(30_000);
  private localPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  private remotePath = '/';
  private connected = false;
  private profile: ConnectionProfile | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => void this.handleMessage(message), undefined, context.subscriptions);
    this.panel.onDidDispose(() => {
      this.client.close();
      this.connected = false;
      CommanderPanel.current = undefined;
    }, undefined, context.subscriptions);
  }

  private getHtml(): string {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'browser');
    const indexPath = path.join(root.fsPath, 'index.html');
    let html: string;
    try {
      html = fsSync.readFileSync(indexPath, 'utf8');
    } catch {
      return '<!doctype html><html><body><p>Angular webview has not been built. Run <code>npm run build</code>.</p></body></html>';
    }

    const nonce = getNonce();
    const toWebviewUri = (assetPath: string): string => {
      const asset = vscode.Uri.joinPath(root, assetPath.replace(/^\.\//, ''));
      return this.panel.webview.asWebviewUri(asset).toString();
    };
    html = html.replace(/<script([^>]*?)src="([^"]+)"([^>]*)>/g, (_match, before: string, src: string, after: string) =>
      `<script nonce="${nonce}"${before}src="${toWebviewUri(src)}"${after}>`
    );
    html = html.replace(/<link([^>]*?)href="([^"]+\.css)"([^>]*)>/g, (_match, before: string, href: string, after: string) =>
      `<link${before}href="${toWebviewUri(href)}"${after}>`
    );
    const csp = this.panel.webview.cspSource;
    html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${csp}; font-src ${csp} https://fonts.gstatic.com;">`);
    return html;
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInitialState();
          break;
        case 'connect':
          await this.connect(message.profile ?? {}, message.password ?? '');
          break;
        case 'disconnect':
          this.client.close();
          this.connected = false;
          await this.refresh();
          break;
        case 'refresh':
          await this.refresh();
          break;
        case 'navigate':
          await this.navigate(message.pane, message.path);
          break;
        case 'parent':
          await this.navigateParent(message.pane);
          break;
        case 'copy':
          await this.copy(message.source, message.path);
          break;
        case 'create-folder':
          await this.createFolder(message.pane);
          break;
        case 'open-file':
          await this.openFile(message.pane, message.path);
          break;
      }
    } catch (error) {
      this.post({ type: 'error', error: errorMessage(error) });
      await this.sendListings().catch(() => undefined);
    }
  }

  private async sendInitialState(): Promise<void> {
    const profile = this.context.globalState.get<ConnectionProfile>(PROFILE_KEY);
    this.profile = profile;
    this.post({ type: 'data', localPath: this.localPath, remotePath: this.remotePath, profile, connected: this.connected });
    await this.refresh();
  }

  private async connect(rawProfile: Partial<ConnectionProfile>, suppliedPassword: string): Promise<void> {
    const profile = validateProfile(rawProfile);
    const passwordKey = getPasswordKey(profile);
    const password = suppliedPassword || await this.context.secrets.get(passwordKey) || '';
    if (!password) throw new Error('Enter the FTP password.');

    this.client.close();
    this.connected = false;
    await this.client.access({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password,
      secure: profile.protocol === 'ftps'
    });

    this.profile = profile;
    this.connected = true;
    await this.context.globalState.update(PROFILE_KEY, profile);
    await this.context.secrets.store(passwordKey, password);
    this.remotePath = '/';
    await this.refresh('Connected. F5 copies the selected file.');
  }

  private async navigate(pane: Pane | undefined, requestedPath: string | undefined): Promise<void> {
    if (!pane || !requestedPath) return;
    if (pane === 'local') {
      this.localPath = path.resolve(requestedPath);
    } else {
      this.requireConnection();
      this.remotePath = normalizeRemotePath(requestedPath);
    }
    await this.refresh();
  }

  private async navigateParent(pane: Pane | undefined): Promise<void> {
    if (pane === 'local') this.localPath = path.dirname(this.localPath);
    if (pane === 'remote') {
      this.requireConnection();
      this.remotePath = posix.dirname(this.remotePath) || '/';
    }
    await this.refresh();
  }

  private async copy(source: Pane | undefined, selectedPath: string | undefined): Promise<void> {
    if (!source || !selectedPath) return;
    this.requireConnection();

    if (source === 'local') {
      const stat = await fs.stat(selectedPath);
      if (!stat.isFile()) throw new Error('Select a file to upload.');
      const target = posix.join(this.remotePath, path.basename(selectedPath));
      const remoteEntries = await this.client.list(this.remotePath);
      if (remoteEntries.some((entry) => entry.name === path.basename(target))) {
        const confirmed = await vscode.window.showWarningMessage(`Replace ${path.basename(target)} on the FTP server?`, { modal: true }, 'Replace');
        if (confirmed !== 'Replace') return this.reportTransfer('Upload cancelled.');
      }
      await this.client.uploadFrom(selectedPath, target);
      return this.reportTransfer(`Uploaded ${path.basename(selectedPath)}.`);
    }

    const remoteName = posix.basename(selectedPath);
    const target = path.join(this.localPath, remoteName);
    try {
      await fs.access(target);
      const confirmed = await vscode.window.showWarningMessage(`Replace local file ${remoteName}?`, { modal: true }, 'Replace');
      if (confirmed !== 'Replace') return this.reportTransfer('Download cancelled.');
    } catch {
      // The destination does not exist yet.
    }
    await this.client.downloadTo(target, normalizeRemotePath(selectedPath));
    this.reportTransfer(`Downloaded ${remoteName}.`);
  }

  private async createFolder(pane: Pane | undefined): Promise<void> {
    if (!pane) return;
    if (pane === 'remote') this.requireConnection();
    const name = await vscode.window.showInputBox({
      prompt: `Create a folder in ${pane === 'local' ? this.localPath : this.remotePath}`,
      placeHolder: 'Folder name',
      validateInput: validateFolderName
    });
    if (name === undefined) return;
    const folderName = name.trim();

    if (pane === 'local') {
      await fs.mkdir(path.join(this.localPath, folderName));
    } else {
      const target = posix.join(this.remotePath, folderName);
      await this.client.ensureDir(target);
      await this.client.cd(this.remotePath);
    }
    this.reportTransfer(`Created folder ${folderName}.`);
  }

  private async openFile(pane: Pane | undefined, selectedPath: string | undefined): Promise<void> {
    if (!pane || !selectedPath) return;
    if (pane === 'local') {
      const filePath = path.resolve(selectedPath);
      if (!(await fs.stat(filePath)).isFile()) throw new Error('Select a file to open.');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }

    this.requireConnection();
    const remotePath = normalizeRemotePath(selectedPath);
    const token = randomBytes(16).toString('hex');
    CommanderPanel.readonlyDocuments.set(token, { panel: this, path: remotePath });
    const uri = vscode.Uri.from({
      scheme: 'bm-ftp-readonly',
      authority: token,
      path: `/🔒 ${posix.basename(remotePath)}`
    });
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      CommanderPanel.readonlyDocuments.delete(token);
      throw error;
    }
  }

  private async readRemoteFile(remotePath: string): Promise<string> {
    this.requireConnection();
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    await this.client.downloadTo(stream, remotePath);
    return Buffer.concat(chunks).toString('utf8');
  }

  private reportTransfer(transfer: string): void {
    this.post({ type: 'data', transfer });
    void this.refresh(transfer);
  }

  private async refresh(transfer?: string): Promise<void> {
    await this.sendListings(transfer);
  }

  private async sendListings(transfer?: string): Promise<void> {
    const localEntries = await readLocalEntries(this.localPath);
    this.post({ type: 'data', localPath: this.localPath, localEntries });

    let remoteEntries: FileEntry[] = [];
    if (this.connected) {
      try {
        remoteEntries = mapRemoteEntries(await this.client.list(this.remotePath), this.remotePath);
      } catch (error) {
        this.client.close();
        this.connected = false;
        throw error;
      }
    }

    this.post({
      type: 'data', remotePath: this.remotePath,
      remoteEntries, profile: this.profile, connected: this.connected, transfer
    });
  }

  private requireConnection(): void {
    if (!this.connected) throw new Error('Connect to an FTP server first.');
  }

  private post(message: object): void {
    void this.panel.webview.postMessage(message);
  }
}

async function readLocalEntries(directory: string): Promise<FileEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const mapped = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    const stat = await fs.stat(fullPath);
    return {
      name: entry.name,
      path: fullPath,
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
      size: stat.size,
      modified: stat.mtime.toLocaleDateString()
    };
  }));
  return mapped.sort(sortEntries);
}

function mapRemoteEntries(entries: FileInfo[], directory: string): FileEntry[] {
  return entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .map((entry) => ({
      name: entry.name,
      path: posix.join(directory, entry.name),
      kind: entry.isDirectory ? 'directory' as const : 'file' as const,
      size: entry.size,
      modified: entry.modifiedAt?.toLocaleDateString()
    }))
    .sort(sortEntries);
}

function sortEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function validateProfile(raw: Partial<ConnectionProfile>): ConnectionProfile {
  const host = (raw.host ?? '').trim();
  const username = (raw.username ?? '').trim();
  const port = Number(raw.port ?? 21);
  const protocol: Protocol = raw.protocol === 'ftp' ? 'ftp' : 'ftps';
  if (!host || /[\s\r\n]/.test(host)) throw new Error('Enter a valid FTP host.');
  if (!username) throw new Error('Enter the FTP username.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Enter a port between 1 and 65535.');
  return { host, port, username, protocol };
}

function normalizeRemotePath(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('FTP path contains an invalid character.');
  return posix.resolve('/', value);
}

function validateFolderName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return 'Enter a folder name.';
  if (name === '.' || name === '..' || /[\\/\0-\x1f\x7f]/.test(name)) return 'Use a folder name without path separators or control characters.';
  return undefined;
}

function getPasswordKey(profile: ConnectionProfile): string {
  return `${PASSWORD_KEY}.${encodeURIComponent(profile.host.toLowerCase())}.${encodeURIComponent(profile.username)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown FTP error occurred.';
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}
