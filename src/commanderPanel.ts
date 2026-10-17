import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as posix from 'node:path/posix';
import { PassThrough } from 'node:stream';
import { Client, FileInfo } from 'basic-ftp';
import { AgentBridge, AgentRequest } from './agentBridge';
import { ensurePrivateDirectory, getCodexRuntimePaths, installCodexLauncher, installCodexServerEntry, isCodexConfigured, publishCodexGrant, removeCodexGrant } from './codexAgentAccess';
import { isSafeRemoteName, isSensitiveAgentFilename, resolveGrantedRemotePath, toGrantedRemotePath } from './mcpPolicy';
import { ConnectionProfile, FileEntry, OperationQueue, downloadAtomically, getPasswordKey, normalizeRemotePath, readLocalEntries, replaceRemoteFile, sortEntries, validateFolderName, validateProfile } from './core';

type Pane = 'local' | 'remote';

interface PanelMessage {
  type: string;
  pane?: Pane;
  path?: string;
  paths?: string[];
  name?: string;
  source?: Pane;
  password?: string;
  relative?: boolean;
  profile?: Partial<ConnectionProfile>;
}

interface CopyProgress {
  direction: 'upload' | 'download';
  name: string;
  total: number;
  transferred: number;
  verified: number;
  totalItems: number;
  copiedItems: number;
  verifiedItems: number;
  phase: 'transfer' | 'verify';
}

interface CopyItem {
  relativePath: string;
  sourcePath: string;
  kind: FileEntry['kind'];
  size: number;
}

const PROFILE_KEY = 'bm.ftp.profile';

export class CommanderPanel {
  private static current: CommanderPanel | undefined;
  private static readonlyDocuments = new Map<string, { panel: CommanderPanel; path: string; content?: string }>();
  static readonly agentAccessChanged = new vscode.EventEmitter<void>();

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
    CommanderPanel.current?.shutdown();
    CommanderPanel.current = undefined;
  }

  static async enableAgentAccess(): Promise<void> {
    const panel = CommanderPanel.current;
    if (!panel?.connected) throw new Error('Connect to an FTP server in bm.ftp first.');
    const sessionId = panel.agentSessionId;
    const root = await vscode.window.showInputBox({
      title: 'Grant FTP access to agents',
      prompt: 'Remote directory root available to the agent. Use / for the account root.',
      value: panel.remotePath || '/',
      validateInput: (value) => {
        if (!value.startsWith('/') || /[\\\0\r\n\x01-\x1f\x7f]/.test(value)) return 'Enter an absolute FTP directory path beginning with / and without control characters or backslashes.';
        return undefined;
      }
    });
    if (root === undefined) return;
    if (!panel.isGrantSessionCurrent(sessionId)) throw new Error('The FTP session changed while access was being granted. Try again.');
    const normalizedRoot = normalizeRemotePath(root);
    const confirmed = await vscode.window.showWarningMessage(
      `Allow the connected agent to list folders, search names, and read text files under FTP root '${normalizedRoot}'? File contents may be sent to the selected AI model. Access ends when you disconnect or close bm.ftp.`,
      { modal: true }, 'Grant read-only access'
    );
    if (confirmed !== 'Grant read-only access') return;
    if (!panel.isGrantSessionCurrent(sessionId)) throw new Error('The FTP session changed while access was being granted. Try again.');
    await panel.grantAgentAccess(normalizedRoot, sessionId);
  }

  static getAgentServerDefinition(): vscode.McpStdioServerDefinition[] {
    return CommanderPanel.current?.getAgentServerDefinition() ?? [];
  }

  static revokeAgentAccess(): void {
    CommanderPanel.current?.revokeAgentAccess();
  }

  static async copyCodexConfiguration(context: vscode.ExtensionContext): Promise<void> {
    if (process.platform === 'win32') throw new Error('Direct Codex MCP registration is currently supported on macOS and Linux only; Windows ACL validation is still required.');
    const paths = getCodexRuntimePaths(context.globalStorageUri.fsPath);
    const source = path.join(context.extensionPath, 'mcp', 'codex-launcher.mjs');
    await installCodexLauncher(source, paths.runtime, paths.launcher);
    await ensurePrivateDirectory(paths.grants);
    await installCodexServerEntry(paths.serverEntry, path.join(context.extensionPath, 'mcp', 'server.mjs'));
    const quote = (value: string): string => JSON.stringify(value);
    const snippet = `[mcp_servers.bm_ftp]\ncommand = "node"\nargs = [${quote(paths.launcher)}, "--registry", ${quote(paths.grants)}]\nstartup_timeout_sec = 10\ntool_timeout_sec = 60`;
    await vscode.env.clipboard.writeText(snippet);
    void vscode.window.showInformationMessage('One-time Codex MCP configuration copied. Add it to Codex config.toml and reload Codex MCP servers. Future FTP sessions can be granted from bm.ftp without restarting Codex.');
  }

  private readonly client = new Client(30_000);
  private localPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  private remotePath = '/';
  private connected = false;
  private disposed = false;
  private copyProgress: CopyProgress | undefined;
  private profile: ConnectionProfile | undefined;
  private readonly operationQueue = new OperationQueue();
  private agentBridge: AgentBridge | undefined;
  private agentRoot = '/';
  private agentSessionId = '';
  private codexGrantFile: string | undefined;
  private connectionMonitor: NodeJS.Timeout | undefined;
  private connectionCheckPending = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => {
      void this.enqueue(() => this.handleMessage(message));
    }, undefined, context.subscriptions);
    this.panel.onDidDispose(() => {
      this.shutdown();
      CommanderPanel.current = undefined;
    }, undefined, context.subscriptions);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.operationQueue.enqueue(operation);
  }

  private shutdown(): void {
    this.disposed = true;
    this.stopConnectionMonitor();
    this.revokeAgentAccess();
    this.operationQueue.close();
    this.client.close();
    this.connected = false;
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
    if (this.disposed) return;
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInitialState();
          break;
        case 'connect':
          await this.connect(message.profile ?? {}, message.password ?? '');
          break;
        case 'disconnect':
          this.stopConnectionMonitor();
          this.revokeAgentAccess();
          this.client.close();
          this.connected = false;
          await this.refresh();
          break;
        case 'refresh':
          if (message.pane) await this.refreshPane(message.pane);
          else await this.refresh();
          break;
        case 'navigate':
          await this.navigate(message.pane, message.path);
          break;
        case 'parent':
          await this.navigateParent(message.pane);
          break;
        case 'copy':
          await this.copy(message.source, message.paths ?? (message.path ? [message.path] : []));
          break;
        case 'delete':
          await this.deleteEntries(message.pane, message.paths ?? []);
          break;
        case 'create-folder':
          await this.createFolder(message.pane);
          break;
        case 'open-file':
          await this.openFile(message.pane, message.path);
          break;
        case 'copy-path':
          await this.copyPath(message.pane, message.path, message.relative === true);
          break;
      }
    } catch (error) {
      if (this.disposed) return;
      this.post({ type: 'error', operation: message.type, error: errorMessage(error) });
      await this.sendListings().catch(() => undefined);
    }
  }

  private async sendInitialState(): Promise<void> {
    const profile = this.context.globalState.get<ConnectionProfile>(PROFILE_KEY);
    this.profile = profile;
    const logoUri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'browser', 'assets', 'westbohemia-logo-animated-transparent-128.png');
    const logoUrl = this.panel.webview.asWebviewUri(logoUri).toString();
    this.post({ type: 'data', localPath: this.localPath, remotePath: this.remotePath, profile, connected: this.connected, logoUrl });
    await this.refresh();
  }

  private async connect(rawProfile: Partial<ConnectionProfile>, suppliedPassword: string): Promise<void> {
    const profile = validateProfile(rawProfile);
    const passwordKey = getPasswordKey(profile);
    const password = suppliedPassword || await this.context.secrets.get(passwordKey) || '';
    if (this.disposed) return;
    if (!password) throw new Error('Enter the FTP password.');

    this.stopConnectionMonitor();
    this.revokeAgentAccess();
    this.client.close();
    this.connected = false;
    await this.client.access({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password,
      secure: profile.protocol === 'ftps'
    });
    if (this.disposed) {
      this.client.close();
      return;
    }

    this.profile = profile;
    this.connected = true;
    this.agentSessionId = randomBytes(16).toString('hex');
    this.startConnectionMonitor();
    await this.context.globalState.update(PROFILE_KEY, profile);
    await this.context.secrets.store(passwordKey, password);
    this.remotePath = '/';
    await this.refresh('Connected.');
  }

  private async navigate(pane: Pane | undefined, requestedPath: string | undefined): Promise<void> {
    if (!pane || !requestedPath) return;
    if (pane === 'local') {
      const targetPath = path.resolve(requestedPath);
      await fs.readdir(targetPath);
      if (this.disposed) return;
      this.localPath = targetPath;
    } else {
      this.requireConnection();
      const targetPath = normalizeRemotePath(requestedPath);
      await this.client.list(targetPath);
      if (this.disposed) return;
      this.remotePath = targetPath;
    }
    await this.refresh();
  }

  private async navigateParent(pane: Pane | undefined): Promise<void> {
    if (pane === 'local') return this.navigate('local', path.dirname(this.localPath));
    if (pane === 'remote') return this.navigate('remote', posix.dirname(this.remotePath) || '/');
  }

  private async copy(source: Pane | undefined, selectedPaths: string[]): Promise<void> {
    try {
      await this.copyItems(source, selectedPaths);
    } catch (error) {
      if (this.copyProgress && this.copyProgress.copiedItems > 0) {
        throw new Error(`Copy stopped after ${this.copyProgress.copiedItems} of ${this.copyProgress.totalItems} items: ${errorMessage(error)}`);
      }
      throw error;
    } finally {
      this.copyProgress = undefined;
      this.post({ type: 'copy-progress', progress: null });
    }
  }

  private async copyItems(source: Pane | undefined, requestedPaths: string[]): Promise<void> {
    if (!source || !requestedPaths.length) return;
    this.requireConnection();
    const paths = [...new Set(requestedPaths)];
    const items = source === 'local'
      ? await this.scanLocalSelection(paths)
      : await this.scanRemoteSelection(paths);
    const total = items.filter((item) => item.kind === 'file').reduce((sum, item) => sum + item.size, 0);
    const conflicts = await this.checkCopyDestinations(source, items);
    if (conflicts.length) {
      const names = conflicts.slice(0, 8);
      if (conflicts.length > names.length) names.push(`… and ${conflicts.length - names.length} more`);
      const confirmed = await vscode.window.showWarningMessage(
        `Replace ${conflicts.length} existing file${conflicts.length === 1 ? '' : 's'} in the ${source === 'local' ? 'FTP' : 'local'} folder?\n\n${names.join('\n')}\n\nExisting folders will be merged.`,
        { modal: true },
        'Replace'
      );
      if (this.disposed) return;
      if (confirmed !== 'Replace') return this.reportTransfer('Copy cancelled.');
    }
    if (this.disposed) return;
    const recheckedConflicts = await this.checkCopyDestinations(source, items);
    if (this.disposed) return;
    if (recheckedConflicts.some((name) => !conflicts.includes(name))) {
      throw new Error('A destination file appeared while confirmation was open. Review the folder and copy again.');
    }

    const direction = source === 'local' ? 'upload' : 'download';
    this.beginCopyProgress(direction, `${paths.length} selected item${paths.length === 1 ? '' : 's'}`, total, items.length);
    let completedTransferred = 0;
    let completedVerified = 0;
    const directories = items.filter((item) => item.kind === 'directory').sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const item of directories) {
      if (this.disposed) return;
      this.updateCopyProgress({ name: item.relativePath, phase: 'transfer' });
      if (source === 'local') {
        const target = posix.join(this.remotePath, ...item.relativePath.split('/'));
        await this.client.ensureDir(target);
        await this.client.cd(this.remotePath);
      } else {
        const target = path.resolve(this.localPath, ...item.relativePath.split('/'));
        await fs.mkdir(target, { recursive: true });
      }
      this.updateCopyProgress({ copiedItems: (this.copyProgress?.copiedItems ?? 0) + 1, verifiedItems: (this.copyProgress?.verifiedItems ?? 0) + 1 });
    }

    for (const item of items.filter((candidate) => candidate.kind === 'file')) {
      if (this.disposed) return;
      this.updateCopyProgress({ name: item.relativePath, phase: 'transfer' });
      if (source === 'local') {
        const target = posix.join(this.remotePath, ...item.relativePath.split('/'));
        await replaceRemoteFile(
          async (stagingPath) => {
            await this.runTrackedTransfer('upload', total, item.size, completedTransferred, () => this.client.uploadFrom(item.sourcePath, stagingPath));
            completedTransferred += item.size;
            this.updateCopyProgress({ transferred: completedTransferred, phase: 'verify' });
            const uploadedSize = await this.client.size(stagingPath);
            if (uploadedSize !== item.size) throw new Error(`Upload validation failed for '${item.relativePath}': expected ${item.size} bytes, received ${uploadedSize}.`);
          },
          target,
          conflicts.includes(item.relativePath),
          (from, to) => this.client.rename(from, to).then(() => undefined),
          (remotePath) => this.client.remove(remotePath).then(() => undefined)
        );
      } else {
        const target = path.resolve(this.localPath, ...item.relativePath.split('/'));
        await downloadAtomically(target, async (stagingPath) => {
          await this.runTrackedTransfer('download', total, item.size, completedTransferred, () => this.client.downloadTo(stagingPath, item.sourcePath));
          completedTransferred += item.size;
          this.updateCopyProgress({ transferred: completedTransferred, phase: 'verify' });
          const downloadedSize = (await fs.stat(stagingPath)).size;
          if (downloadedSize !== item.size) throw new Error(`Download validation failed for '${item.relativePath}': expected ${item.size} bytes, received ${downloadedSize}.`);
        });
      }
      completedVerified += item.size;
      this.updateCopyProgress({
        verified: completedVerified,
        copiedItems: (this.copyProgress?.copiedItems ?? 0) + 1,
        verifiedItems: (this.copyProgress?.verifiedItems ?? 0) + 1
      });
    }

    await this.reportTransfer(`Copied ${items.length} item${items.length === 1 ? '' : 's'} ${source === 'local' ? 'to FTP' : 'to the local folder'}.`);
  }

  private beginCopyProgress(direction: CopyProgress['direction'], name: string, total: number, totalItems: number): void {
    this.copyProgress = { direction, name, total, transferred: 0, verified: 0, totalItems, copiedItems: 0, verifiedItems: 0, phase: 'transfer' };
    this.post({ type: 'copy-progress', progress: this.copyProgress });
  }

  private updateCopyProgress(update: Partial<CopyProgress>): void {
    if (!this.copyProgress) return;
    this.copyProgress = { ...this.copyProgress, ...update };
    this.post({ type: 'copy-progress', progress: this.copyProgress });
  }

  private async runTrackedTransfer<T>(direction: CopyProgress['direction'], total: number, fileSize: number, completedBytes: number, transfer: () => Promise<T>): Promise<T> {
    let latestBytes = 0;
    this.client.trackProgress((info) => {
      if (info.type !== direction) return;
      latestBytes = Math.max(latestBytes, info.bytes);
      this.updateCopyProgress({ transferred: Math.min(total, completedBytes + Math.min(latestBytes, fileSize)) });
    });
    try {
      const result = await transfer();
      this.updateCopyProgress({ transferred: Math.min(total, completedBytes + fileSize) });
      return result;
    } finally {
      this.client.trackProgress();
    }
  }

  private async scanLocalSelection(requestedPaths: string[]): Promise<CopyItem[]> {
    const directory = path.resolve(this.localPath);
    const selected = [...new Set(requestedPaths.map((selectedPath) => path.resolve(selectedPath)))];
    const items: CopyItem[] = [];
    const visit = async (sourcePath: string, relativePath: string): Promise<void> => {
      const name = posix.basename(relativePath);
      validateCopyName(name);
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink()) throw new Error(`Cannot recursively copy symbolic link '${relativePath}'.`);
      if (stat.isDirectory()) {
        items.push({ sourcePath, relativePath, kind: 'directory', size: 0 });
        const children = await fs.readdir(sourcePath);
        for (const child of children) await visit(path.join(sourcePath, child), posix.join(relativePath, child));
      } else if (stat.isFile()) {
        items.push({ sourcePath, relativePath, kind: 'file', size: stat.size });
      } else {
        throw new Error(`Cannot copy unsupported local item '${relativePath}'.`);
      }
    };

    for (const selectedPath of selected) {
      if (path.dirname(selectedPath) !== directory) throw new Error('Select items from the current local folder.');
      await visit(selectedPath, path.basename(selectedPath));
    }
    return items;
  }

  private async scanRemoteSelection(requestedPaths: string[]): Promise<CopyItem[]> {
    const directory = normalizeRemotePath(this.remotePath);
    const selected = [...new Set(requestedPaths.map((selectedPath) => normalizeRemotePath(selectedPath)))];
    const roots = await this.client.list(directory);
    const items: CopyItem[] = [];
    const visit = async (sourcePath: string, relativePath: string, entry: FileInfo): Promise<void> => {
      validateCopyName(entry.name);
      if (entry.isSymbolicLink) throw new Error(`Cannot recursively copy FTP symbolic link '${relativePath}'.`);
      if (entry.isDirectory) {
        items.push({ sourcePath, relativePath, kind: 'directory', size: 0 });
        for (const child of await this.client.list(sourcePath)) {
          if (child.name === '.' || child.name === '..') continue;
          await visit(posix.join(sourcePath, child.name), posix.join(relativePath, child.name), child);
        }
      } else if (entry.isFile) {
        const size = Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : await this.client.size(sourcePath);
        if (!Number.isFinite(size) || size < 0) throw new Error(`Could not determine the size of FTP file '${relativePath}'.`);
        items.push({ sourcePath, relativePath, kind: 'file', size });
      } else {
        throw new Error(`Cannot copy unsupported FTP item '${relativePath}'.`);
      }
    };

    for (const selectedPath of selected) {
      if (posix.dirname(selectedPath) !== directory) throw new Error('Select items from the current FTP folder.');
      const entry = roots.find((candidate) => candidate.name === posix.basename(selectedPath));
      if (!entry) throw new Error(`FTP item '${posix.basename(selectedPath)}' no longer exists.`);
      await visit(selectedPath, entry.name, entry);
    }
    return items;
  }

  private async checkCopyDestinations(source: Pane, items: CopyItem[]): Promise<string[]> {
    if (source === 'remote') {
      assertLocalDestinationNamesDoNotCollide(items);
      const root = path.resolve(this.localPath);
      const conflicts: string[] = [];
      for (const item of items) {
        const target = path.resolve(root, ...item.relativePath.split('/'));
        if (path.dirname(target) !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('A selected item would escape the local destination folder.');
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stat = await fs.lstat(target);
        } catch (error) {
          if (isMissingPath(error)) continue;
          throw error;
        }
        if (stat.isSymbolicLink()) throw new Error(`The local destination '${item.relativePath}' is a symbolic link.`);
        if (item.kind === 'directory' && !stat.isDirectory()) throw new Error(`The local destination '${item.relativePath}' is a file, not a folder.`);
        if (item.kind === 'file' && stat.isDirectory()) throw new Error(`The local destination '${item.relativePath}' is a folder, not a file.`);
        if (item.kind === 'file') conflicts.push(item.relativePath);
      }
      return conflicts;
    }

    const root = normalizeRemotePath(this.remotePath);
    const cache = new Map<string, FileInfo[]>();
    cache.set(root, await this.client.list(root));
    const directories = items.filter((item) => item.kind === 'directory').sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const item of directories) {
      const target = posix.join(root, ...item.relativePath.split('/'));
      const parent = posix.dirname(target);
      const entry = cache.get(parent)?.find((candidate) => candidate.name === posix.basename(target));
      if (entry) {
        if (entry.isSymbolicLink) throw new Error(`The FTP destination '${item.relativePath}' is a symbolic link.`);
        if (!entry.isDirectory) throw new Error(`The FTP destination '${item.relativePath}' is a file, not a folder.`);
        cache.set(target, await this.client.list(target));
      } else {
        cache.set(target, []);
      }
    }

    const conflicts: string[] = [];
    for (const item of items.filter((candidate) => candidate.kind === 'file')) {
      const target = posix.join(root, ...item.relativePath.split('/'));
      const entry = cache.get(posix.dirname(target))?.find((candidate) => candidate.name === posix.basename(target));
      if (!entry) continue;
      if (entry.isSymbolicLink) throw new Error(`The FTP destination '${item.relativePath}' is a symbolic link.`);
      if (!entry.isFile) throw new Error(`The FTP destination '${item.relativePath}' is a folder, not a file.`);
      conflicts.push(item.relativePath);
    }
    return conflicts;
  }

  private async createFolder(pane: Pane | undefined): Promise<void> {
    if (!pane) return;
    if (pane === 'remote') this.requireConnection();
    const name = await vscode.window.showInputBox({
      prompt: `Create a folder in ${pane === 'local' ? this.localPath : this.remotePath}`,
      placeHolder: 'Folder name',
      validateInput: validateFolderName
    });
    if (this.disposed || name === undefined) return;
    const folderName = name.trim();

    if (pane === 'local') {
      await fs.mkdir(path.join(this.localPath, folderName));
    } else {
      const target = posix.join(this.remotePath, folderName);
      await this.client.ensureDir(target);
      await this.client.cd(this.remotePath);
    }
    await this.reportTransfer(`Created folder ${folderName}.`);
  }

  private async deleteEntries(pane: Pane | undefined, requestedPaths: string[]): Promise<void> {
    if (!pane) throw new Error('Choose a file panel before deleting.');
    if (pane === 'remote') this.requireConnection();

    const targets = await this.getDeleteTargets(pane, requestedPaths);
    if (this.disposed) return;
    const names = targets.slice(0, 8).map((target) => target.kind === 'directory' ? `${target.name}/` : target.name);
    if (targets.length > names.length) names.push(`… and ${targets.length - names.length} more`);
    const location = pane === 'local' ? this.localPath : this.remotePath;
    const folderNote = targets.some((target) => target.kind === 'directory')
      ? pane === 'local'
        ? 'Selected folders and their contents will be moved to the system Trash when supported.'
        : 'Selected FTP folders and all their contents will be permanently deleted.'
      : pane === 'local'
        ? 'Selected files will be moved to the system Trash when supported.'
        : 'Selected FTP files will be permanently deleted.';
    const confirmation = await vscode.window.showWarningMessage(
      `Delete ${targets.length} selected item${targets.length === 1 ? '' : 's'} from ${pane === 'local' ? 'local' : 'FTP'} folder ${location}?\n\n${names.join('\n')}\n\n${folderNote}`,
      { modal: true },
      'Delete'
    );
    if (this.disposed) return;
    if (confirmation !== 'Delete') return this.reportTransfer('Deletion cancelled.');

    const confirmedTargets = await this.getDeleteTargets(pane, requestedPaths);
    if (this.disposed) return;
    if (confirmedTargets.some((target, index) => target.path !== targets[index]?.path || target.kind !== targets[index]?.kind)) {
      throw new Error('The selected items changed while confirmation was open. Refresh the folder and try again.');
    }

    let deleted = 0;
    for (const target of confirmedTargets) {
      if (this.disposed) return;
      try {
        if (pane === 'local') {
          await vscode.workspace.fs.delete(vscode.Uri.file(target.path), { recursive: target.kind === 'directory', useTrash: true });
        } else if (target.kind === 'directory') {
          await this.client.removeDir(target.path);
        } else {
          await this.client.remove(target.path);
        }
        deleted += 1;
      } catch (error) {
        throw new Error(`${deleted ? `Deleted ${deleted} of ${confirmedTargets.length} selected items; ` : ''}failed to delete '${target.name}': ${errorMessage(error)}`);
      }
    }

    await this.reportTransfer(`Deleted ${deleted} item${deleted === 1 ? '' : 's'} from ${pane === 'local' ? 'local folder' : 'FTP folder'}.`);
  }

  private async getDeleteTargets(pane: Pane, requestedPaths: string[]): Promise<Array<{ name: string; path: string; kind: FileEntry['kind'] }>> {
    if (!requestedPaths.length) throw new Error('Select at least one file or folder to delete.');
    const directory = pane === 'local' ? path.resolve(this.localPath) : normalizeRemotePath(this.remotePath);
    const paths = [...new Set(requestedPaths.map((requestedPath) => {
      if (typeof requestedPath !== 'string' || !requestedPath) throw new Error('The selection contains an invalid path.');
      const target = pane === 'local' ? path.resolve(requestedPath) : normalizeRemotePath(requestedPath);
      const parent = pane === 'local' ? path.dirname(target) : posix.dirname(target);
      if (target === directory || parent !== directory) throw new Error('Only items directly inside the current folder can be deleted.');
      return target;
    }))];

    if (pane === 'local') {
      const entries = await readLocalEntries(directory);
      const targets: Array<{ name: string; path: string; kind: FileEntry['kind'] }> = [];
      for (const target of paths) {
        const entry = entries.find((candidate) => candidate.path === target);
        if (!entry) throw new Error('A selected local item no longer exists. Refresh the folder and try again.');
        const stat = await fs.lstat(target);
        const kind = stat.isSymbolicLink() ? 'file' : stat.isDirectory() ? 'directory' : 'file';
        targets.push({ name: entry.name, path: target, kind });
      }
      return targets;
    }

    this.requireConnection();
    const entries = await this.client.list(directory);
    const targets: Array<{ name: string; path: string; kind: FileEntry['kind'] }> = [];
    for (const target of paths) {
      const entry = entries.find((candidate) => candidate.name !== '.' && candidate.name !== '..' && posix.join(directory, candidate.name) === target);
      if (!entry) throw new Error('A selected FTP item no longer exists. Refresh the folder and try again.');
      targets.push({ name: entry.name, path: target, kind: entry.isDirectory && !entry.isSymbolicLink ? 'directory' : 'file' });
    }
    return targets;
  }

  private async openFile(pane: Pane | undefined, selectedPath: string | undefined): Promise<void> {
    if (!pane || !selectedPath) return;
    if (pane === 'local') {
      const filePath = path.resolve(selectedPath);
      if (path.dirname(filePath) !== this.localPath) throw new Error('Select a file in the current local folder.');
      if (!(await readLocalEntries(this.localPath)).some((entry) => entry.path === filePath && entry.kind === 'file')) {
        throw new Error('Select a file to open.');
      }
      if (!(await fs.stat(filePath)).isFile()) throw new Error('Select a file to open.');
      if (this.disposed) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }

    this.requireConnection();
    const remotePath = normalizeRemotePath(selectedPath);
    if (posix.dirname(remotePath) !== normalizeRemotePath(this.remotePath)) throw new Error('Select a file in the current FTP folder.');
    const remoteEntry = (await this.client.list(this.remotePath)).find((entry) => posix.join(this.remotePath, entry.name) === remotePath);
    if (!remoteEntry?.isFile) throw new Error('Select a remote file to open.');
    if (this.disposed) return;
    const token = randomBytes(16).toString('hex');
    CommanderPanel.readonlyDocuments.set(token, { panel: this, path: remotePath, content: await this.readRemoteFile(remotePath) });
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

  private async copyPath(pane: Pane | undefined, selectedPath: string | undefined, relative: boolean): Promise<void> {
    if (!pane || !selectedPath) throw new Error('Select a file or folder first.');

    let clipboardPath: string;
    if (pane === 'local') {
      const target = path.resolve(selectedPath);
      if (path.dirname(target) !== this.localPath) throw new Error('The selected local item is no longer in the open folder. Refresh and try again.');
      const entry = (await readLocalEntries(this.localPath)).find((candidate) => candidate.path === target);
      if (!entry) throw new Error('The selected local item no longer exists. Refresh and try again.');

      if (relative) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target));
        if (!workspaceFolder) throw new Error('Relative paths are available only for items inside an open VS Code workspace folder.');
        const relativePath = path.relative(workspaceFolder.uri.fsPath, target) || '.';
        clipboardPath = relativePath === '.' ? relativePath : `${path.sep}${relativePath}`;
      } else {
        clipboardPath = target;
      }
    } else {
      if (relative) throw new Error('Relative paths are available only for local items inside an open VS Code workspace folder.');
      this.requireConnection();
      const target = normalizeRemotePath(selectedPath);
      if (posix.dirname(target) !== normalizeRemotePath(this.remotePath)) throw new Error('The selected FTP item is no longer in the open folder. Refresh and try again.');
      const entry = (await this.client.list(this.remotePath)).find((candidate) => posix.join(this.remotePath, candidate.name) === target);
      if (!entry || !this.profile) throw new Error('The selected FTP item no longer exists. Refresh and try again.');

      const host = this.profile.host.includes(':') && !this.profile.host.startsWith('[')
        ? `[${this.profile.host}]`
        : this.profile.host;
      const url = new URL(`${this.profile.protocol}://${host}`);
      url.username = '';
      url.password = '';
      url.port = String(this.profile.port);
      url.pathname = target.split('/').map((segment) => encodeURIComponent(segment)).join('/');
      clipboardPath = url.toString();
    }

    await vscode.env.clipboard.writeText(clipboardPath);
    this.post({ type: 'data', transfer: relative ? 'Relative path copied.' : 'Path copied.' });
  }

  private async readRemoteFile(remotePath: string): Promise<string> {
    this.requireConnection();
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    try {
      await this.client.downloadTo(stream, remotePath);
    } catch (error) {
      this.post({ type: 'error', operation: 'open-file', error: `Could not read FTP file '${posix.basename(remotePath)}': ${errorMessage(error)}` });
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private isGrantSessionCurrent(sessionId: string): boolean {
    return CommanderPanel.current === this && this.connected && !this.disposed && this.agentSessionId === sessionId;
  }

  private async grantAgentAccess(root: string, expectedSessionId: string): Promise<void> {
    if (!this.isGrantSessionCurrent(expectedSessionId)) throw new Error('The FTP session changed while access was being granted. Try again.');
    this.revokeAgentAccess();
    this.requireConnection();
    this.agentRoot = root;
    const bridge = new AgentBridge((request) => this.handleAgentRequest(request));
    this.agentBridge = bridge;
    try { await bridge.start(); }
    catch (error) {
      bridge.dispose();
      if (this.agentBridge === bridge) this.agentBridge = undefined;
      CommanderPanel.agentAccessChanged.fire();
      throw error;
    }
    if (!this.isGrantSessionCurrent(expectedSessionId) || this.agentBridge !== bridge) {
      bridge.dispose();
      if (this.agentBridge === bridge) this.agentBridge = undefined;
      throw new Error('The FTP session changed while access was being granted. Try again.');
    }
    if (process.platform !== 'win32') {
      const runtimePaths = getCodexRuntimePaths(this.context.globalStorageUri.fsPath);
      if (await isCodexConfigured(runtimePaths.runtime)) {
        try {
          const record = await publishCodexGrant(runtimePaths.grants, bridge, expectedSessionId);
          if (!this.isGrantSessionCurrent(expectedSessionId) || this.agentBridge !== bridge) {
            await removeCodexGrant(record);
            bridge.dispose();
            if (this.agentBridge === bridge) this.agentBridge = undefined;
            throw new Error('The FTP session changed while access was being granted. Try again.');
          }
          this.codexGrantFile = record;
        } catch (error) {
          if (!this.isGrantSessionCurrent(expectedSessionId) || this.agentBridge !== bridge) throw error;
          void vscode.window.showWarningMessage(`FTP agent access is active in bm.ftp, but Codex could not be notified: ${errorMessage(error)}`);
        }
      }
    }
    CommanderPanel.agentAccessChanged.fire();
    void vscode.window.showInformationMessage(`Read-only agent access granted for ${root}.`);
  }

  private revokeAgentAccess(): void {
    void removeCodexGrant(this.codexGrantFile).catch(() => undefined);
    this.codexGrantFile = undefined;
    this.agentBridge?.dispose();
    this.agentBridge = undefined;
    CommanderPanel.agentAccessChanged.fire();
  }

  private getAgentServerDefinition(): vscode.McpStdioServerDefinition[] {
    if (!this.connected || !this.agentBridge) return [];
    const entry = path.join(this.context.extensionPath, 'mcp', 'server.mjs');
    return [new vscode.McpStdioServerDefinition(
      'bm.ftp', process.execPath, ['--ms-enable-electron-run-as-node', entry],
      { BM_FTP_AGENT_ENDPOINT: this.agentBridge.endpoint, BM_FTP_AGENT_TOKEN: this.agentBridge.token },
      '0.2.0'
    )];
  }

  private async handleAgentRequest(request: AgentRequest): Promise<unknown> {
    if (!this.connected || !this.agentBridge) throw new Error('Agent access has been revoked.');
    const bridge = this.agentBridge;
    const params = request.params;
    if (request.method === 'get_session') {
      return { sessionId: this.agentSessionId, connected: true, protocol: this.profile?.protocol, allowedRoot: '/', capabilities: ['list_directory', 'search_files', 'read_file'], limits: { maxDirectoryEntries: 1000, maxSearchDepth: 8, maxSearchDirectories: 2000, maxSearchResults: 1000, maxReadBytes: 1048576, maxReadLines: 400 } };
    }
    if (params.sessionId !== this.agentSessionId) throw new Error('The FTP session changed. Initialize the agent connection again.');
    if (request.method === 'list_directory') {
      return this.enqueue(async () => {
        this.requireAgentGrant(bridge, params.sessionId);
        const target = this.resolveAgentPath(String(params.path ?? '/'));
        await this.assertAgentDirectoryPath(target, bridge, params.sessionId);
        const entries = mapRemoteEntries(await this.client.list(target), target).filter((entry) => isSafeRemoteName(entry.name));
        const limit = boundedInteger(params.limit, 200, 1, 1000);
        return { path: String(params.path ?? '/'), entries: entries.slice(0, limit).map(({ name, path: entryPath, kind, size, modifiedTime }) => ({ name, path: this.toAgentPath(entryPath), kind, size, modifiedTime })), truncated: entries.length > limit };
      });
    }
    if (request.method === 'search_files') {
      return this.enqueue(() => this.searchAgentFiles(params, bridge));
    }
    if (request.method === 'read_file') {
      return this.enqueue(() => this.readAgentFile(params, bridge));
    }
    throw new Error('Unknown agent operation.');
  }

  private resolveAgentPath(requested: string): string {
    return resolveGrantedRemotePath(this.agentRoot, requested);
  }

  private toAgentPath(remotePath: string): string {
    return toGrantedRemotePath(this.agentRoot, remotePath);
  }

  private async searchAgentFiles(params: Record<string, unknown>, bridge: AgentBridge): Promise<unknown> {
    const root = this.resolveAgentPath(String(params.path ?? '/'));
    await this.assertAgentDirectoryPath(root, bridge, params.sessionId);
    const query = String(params.nameQuery ?? '').toLocaleLowerCase();
    if (!query.trim()) throw new Error('Enter a file or folder name to search for.');
    const recursive = params.recursive !== false;
    const maxDepth = boundedInteger(params.maxDepth, 8, 0, 16);
    const maxResults = boundedInteger(params.maxResults, 100, 1, 1000);
    const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const matches: Array<{ name: string; path: string; kind: string; size: number }> = [];
    const visited = new Set<string>();
    let truncated = false;
    while (pending.length && visited.size < 2000 && matches.length < maxResults) {
      this.requireAgentGrant(bridge, params.sessionId);
      const current = pending.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      const entries = (await this.client.list(current.path)).filter((entry) => isSafeRemoteName(entry.name));
      for (const entry of entries) {
        const entryPath = posix.join(current.path, entry.name);
        const kind = entry.isDirectory ? 'directory' : 'file';
        if (entry.name.toLocaleLowerCase().includes(query)) matches.push({ name: entry.name, path: this.toAgentPath(entryPath), kind, size: entry.size });
        if (recursive && entry.isDirectory && !entry.isSymbolicLink && current.depth < maxDepth) pending.push({ path: entryPath, depth: current.depth + 1 });
        if (matches.length >= maxResults) break;
      }
    }
    if (pending.length || visited.size >= 2000 || matches.length >= maxResults) truncated = true;
    return { matches, truncated, visitedDirectories: visited.size };
  }

  private async readAgentFile(params: Record<string, unknown>, bridge: AgentBridge): Promise<unknown> {
    this.requireAgentGrant(bridge, params.sessionId);
    const target = this.resolveAgentPath(String(params.path ?? ''));
    const name = posix.basename(target);
    if (isSensitiveAgentFilename(name)) {
      throw new Error('This file is blocked because its name may identify credentials or a private key.');
    }
    await this.assertAgentDirectoryPath(posix.dirname(target), bridge, params.sessionId);
    const listing = await this.client.list(posix.dirname(target));
    this.requireAgentGrant(bridge, params.sessionId);
    const file = listing.find((entry) => entry.name === name && !entry.isDirectory && !entry.isSymbolicLink);
    if (!file) throw new Error('The requested FTP file was not found.');
    const maxBytes = 1024 * 1024;
    if (file.size > maxBytes) throw new Error('File is larger than the 1 MiB read limit. Use the approved download workflow for larger files.');
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        oversized = true;
        stream.destroy(new Error('FTP file exceeded the agent read limit.'));
        return;
      }
      chunks.push(buffer);
    });
    try { await this.client.downloadTo(stream, target); }
    catch (error) {
      if (oversized) {
        this.connected = false;
        this.stopConnectionMonitor();
        this.revokeAgentAccess();
        this.post({ type: 'data', remotePath: this.remotePath, remoteEntries: [], profile: this.profile, connected: false, transfer: 'FTP connection closed after an oversized agent read.' });
        throw new Error('File exceeded the 1 MiB read limit. FTP disconnected to stop the transfer; reconnect before continuing.');
      }
      throw error;
    }
    this.requireAgentGrant(bridge, params.sessionId);
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(0)) throw new Error('Binary files cannot be read through the agent interface.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('The file is not valid UTF-8 text.'); }
    const lines = text.split(/\r?\n/);
    const startLine = boundedInteger(params.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
    const maxLines = boundedInteger(params.maxLines, 200, 1, 400);
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const fullText = selected.join('\n');
    const output = safeUtf8Prefix(fullText, 64 * 1024);
    return { path: String(params.path), text: output, startLine, endLine: Math.max(startLine - 1, startLine + selected.length - 1), truncated: startLine - 1 + selected.length < lines.length || output.length < fullText.length, encoding: 'utf-8', size: bytes.length, modifiedTime: file.modifiedAt?.getTime() };
  }

  private requireAgentGrant(bridge: AgentBridge, sessionId: unknown): void {
    if (!this.connected || this.agentBridge !== bridge || sessionId !== this.agentSessionId) {
      throw new Error('Agent access has been revoked or the FTP session changed.');
    }
  }

  private async assertAgentDirectoryPath(directory: string, bridge: AgentBridge, sessionId: unknown): Promise<void> {
    let current = '/';
    for (const segment of directory.split('/').filter(Boolean)) {
      this.requireAgentGrant(bridge, sessionId);
      const entry = (await this.client.list(current)).find((candidate) => candidate.name === segment);
      if (!entry || !entry.isDirectory || entry.isSymbolicLink) throw new Error('The FTP path is missing, is not a folder, or crosses a symbolic link.');
      current = posix.join(current, segment);
    }
  }

  private async reportTransfer(transfer: string): Promise<void> {
    this.post({ type: 'data', transfer });
    await this.refresh(transfer);
  }

  private async refresh(transfer?: string): Promise<void> {
    await this.sendListings(transfer);
  }

  private async refreshPane(pane: Pane): Promise<void> {
    if (this.disposed) return;
    if (pane === 'local') {
      try {
        const localEntries = this.addWorkspaceRelativePaths(await readLocalEntries(this.localPath));
        this.post({ type: 'data', localPath: this.localPath, localEntries });
      } catch (error) {
        this.post({ type: 'error', operation: 'local-listing', error: `Local folder: ${errorMessage(error)}` });
      }
      return;
    }

    let remoteEntries: FileEntry[] = [];
    if (this.connected) {
      try {
        remoteEntries = mapRemoteEntries(await this.client.list(this.remotePath), this.remotePath);
      } catch (error) {
        if (this.client.closed) this.markConnectionLost();
        this.post({ type: 'error', operation: 'remote-listing', error: `FTP folder: ${errorMessage(error)}` });
      }
    }
    this.post({
      type: 'data', remotePath: this.remotePath,
      remoteEntries, profile: this.profile, connected: this.connected
    });
  }

  private async sendListings(transfer?: string): Promise<void> {
    if (this.disposed) return;
    try {
      const localEntries = this.addWorkspaceRelativePaths(await readLocalEntries(this.localPath));
      this.post({ type: 'data', localPath: this.localPath, localEntries });
    } catch (error) {
      this.post({ type: 'error', operation: 'local-listing', error: `Local folder: ${errorMessage(error)}` });
    }

    let remoteEntries: FileEntry[] = [];
    if (this.connected) {
      try {
        remoteEntries = mapRemoteEntries(await this.client.list(this.remotePath), this.remotePath);
      } catch (error) {
        if (this.client.closed) this.markConnectionLost();
        this.post({ type: 'error', operation: 'remote-listing', error: `FTP folder: ${errorMessage(error)}` });
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

  private startConnectionMonitor(): void {
    this.stopConnectionMonitor();
    this.connectionMonitor = setInterval(() => {
      if (this.connectionCheckPending || !this.connected || this.disposed) return;
      this.connectionCheckPending = true;
      void this.enqueue(async () => {
        try {
          await this.checkConnection();
        } finally {
          this.connectionCheckPending = false;
        }
      }).catch(() => { this.connectionCheckPending = false; });
    }, 60_000);
  }

  private stopConnectionMonitor(): void {
    if (this.connectionMonitor) clearInterval(this.connectionMonitor);
    this.connectionMonitor = undefined;
  }

  private async checkConnection(): Promise<void> {
    if (this.disposed || !this.connected) return;
    if (this.client.closed) {
      this.markConnectionLost();
      return;
    }
    try {
      await this.client.sendIgnoringError('NOOP');
      if (this.client.closed) this.markConnectionLost();
    } catch {
      this.markConnectionLost();
    }
  }

  private markConnectionLost(): void {
    if (!this.connected) return;
    this.stopConnectionMonitor();
    this.connected = false;
    this.client.close();
    this.revokeAgentAccess();
    this.post({
      type: 'data', remotePath: this.remotePath, remoteEntries: [], profile: this.profile,
      connected: false, transfer: 'FTP connection lost. Click Connect to reconnect.'
    });
  }

  private addWorkspaceRelativePaths(entries: FileEntry[]): FileEntry[] {
    return entries.map((entry) => {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.path));
      return folder
        ? { ...entry, relativePath: path.relative(folder.uri.fsPath, entry.path) || '.' }
        : entry;
    });
  }

  private post(message: object): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }
}

function mapRemoteEntries(entries: FileInfo[], directory: string): FileEntry[] {
  return entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .map((entry) => ({
      name: entry.name,
      path: posix.join(directory, entry.name),
      kind: entry.isDirectory ? 'directory' as const : 'file' as const,
      size: entry.size,
      modified: entry.modifiedAt?.toLocaleDateString(),
      modifiedTime: entry.modifiedAt?.getTime()
    }))
    .sort(sortEntries);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown FTP error occurred.';
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Value must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function safeUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try { return decoder.decode(bytes.subarray(0, end)); }
    catch { /* Trim a partial trailing code point. */ }
  }
  return '';
}

function validateCopyName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/:\0-\x1f\x7f]/.test(name)) {
    throw new Error(`The item name '${name}' cannot be copied safely between the panels.`);
  }
}

function assertLocalDestinationNamesDoNotCollide(items: CopyItem[]): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const names = new Map<string, string>();
  for (const item of items) {
    const key = item.relativePath.normalize('NFD').toLocaleLowerCase('en-US');
    const previous = names.get(key);
    if (previous && previous !== item.relativePath) {
      throw new Error(`FTP items '${previous}' and '${item.relativePath}' would overwrite each other on this local filesystem.`);
    }
    names.set(key, item.relativePath);
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}
