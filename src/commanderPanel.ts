import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as posix from 'node:path/posix';
import { PassThrough } from 'node:stream';
import type { RemoteEntry, RemoteTransport } from './remoteTransport';
import { FtpTransport } from './ftpTransport';
import { SftpTransport } from './sftpTransport';
import { AgentBridge, AgentRequest } from './agentBridge';
import { ensurePrivateDirectory, getCodexRuntimePaths, installCodexLauncher, installCodexServerEntry, isCodexConfigured, publishCodexGrant, removeCodexGrant } from './codexAgentAccess';
import { isSafeRemoteName, isSensitiveAgentFilename, resolveGrantedRemotePath, toGrantedRemotePath } from './mcpPolicy';
import { ConnectionProfile, FileEntry, OperationQueue, downloadAtomically, getPasswordKey, normalizeRemotePath, readLocalEntries, replaceRemoteFile, sortEntries, validateFolderName, validateProfile } from './core';
import { LAST_PROFILE_KEY, SAVED_PROFILES_KEY, addSavedProfile, profileIdentity, readSavedProfiles, removeSavedProfile } from './savedConnections';

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
  requestId?: string;
  success?: boolean;
  error?: string;
  selectedPaths?: string[];
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

export class CommanderPanel {
  private static current: CommanderPanel | undefined;
  private static readonlyDocuments = new Map<string, { panel: CommanderPanel; path: string; content?: string }>();
  static readonly agentAccessChanged = new vscode.EventEmitter<void>();

  static registerReadonlyDocuments(): vscode.Disposable {
    const readonlyStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    readonlyStatus.text = '$(lock) Remote · Read-only';
    readonlyStatus.tooltip = 'This is a read-only copy opened from a remote server. Changes cannot be saved to the server.';
    const updateReadonlyStatus = (editor: vscode.TextEditor | undefined): void => {
      if (editor?.document.uri.scheme === 'bm-ftp-readonly') readonlyStatus.show();
      else readonlyStatus.hide();
    };
    updateReadonlyStatus(vscode.window.activeTextEditor);
    const editorListener = vscode.window.onDidChangeActiveTextEditor(updateReadonlyStatus);
    const provider = vscode.workspace.registerTextDocumentContentProvider('bm-ftp-readonly', {
      provideTextDocumentContent: async (uri) => {
        const document = CommanderPanel.readonlyDocuments.get(uri.authority);
        if (!document) throw new Error('The remote document is no longer available.');
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

  static async enableAgentAccess(context: vscode.ExtensionContext): Promise<void> {
    CommanderPanel.createOrShow(context);
    const panel = CommanderPanel.current;
    if (!panel) throw new Error('Open bm.ftp first.');
    if (panel.agentGrantPending) return;
    panel.agentGrantPending = true;
    panel.postAgentAccessState();
    try {
      const sessionId = panel.agentSessionId;
      const remoteConnected = panel.connected;
      const connectionRevision = panel.connectionRevision;
      const accessRevision = panel.agentAccessRevision;
      const localRoot = await fs.realpath(path.parse(os.homedir()).root);
      if (!panel.isGrantSessionCurrent(sessionId, connectionRevision) || panel.agentAccessRevision !== accessRevision) throw new Error('Agent access or the FTP session changed while access was being granted. Try again.');
      const confirmed = await vscode.window.showWarningMessage(
        `Allow the agent to list, search, and read text files under local filesystem root '${localRoot}' and FTP root '/'${remoteConnected ? ' on the connected server' : ' on any server connected later'}? Local and remote text contents may be sent to the AI model. The agent can navigate panes and change selections; it cannot write or delete files through this access. Access remains authorized across FTP connections until revoked or bm.ftp closes.`,
        { modal: true }, 'Grant agent access'
      );
      if (confirmed !== 'Grant agent access') return;
      if (!panel.isGrantSessionCurrent(sessionId, connectionRevision) || panel.agentAccessRevision !== accessRevision) throw new Error('Agent access or the FTP session changed while access was being granted. Try again.');
      if (panel.agentBridge && panel.localAgentRoot) {
        if (panel.localAgentRoot !== localRoot) throw new Error('The granted local root changed. Revoke access and grant it again.');
        panel.agentRoot = '/';
        panel.remoteAccessGranted = true;
        CommanderPanel.agentAccessChanged.fire();
        panel.postAgentAccessState();
        void vscode.window.showInformationMessage(`Agent access granted for FTP root / and local root ${localRoot}.`);
        return;
      }
      await panel.grantAgentAccess('/', localRoot, sessionId, true, connectionRevision);
    } finally {
      panel.agentGrantPending = false;
      panel.postAgentAccessState();
    }
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

  private client: RemoteTransport = new FtpTransport('ftps');
  private localPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  private remotePath = '/';
  private connected = false;
  private remoteAccessGranted = false;
  private connectionRevision = 0;
  private disposed = false;
  private copyProgress: CopyProgress | undefined;
  private profile: ConnectionProfile | undefined;
  private savedProfiles: ConnectionProfile[] = [];
  private profilesLoaded = false;
  private readonly operationQueue = new OperationQueue();
  private agentBridge: AgentBridge | undefined;
  private agentGrantPending = false;
  private agentAccessRevision = 0;
  private agentRoot = '/';
  private localAgentRoot: string | undefined;
  private localAgentGrantId = '';
  private localRevision = 0;
  private remoteRevision = 0;
  private readonly agentUiRequests = new Map<string, (message: PanelMessage) => void>();
  private agentSessionId = randomBytes(16).toString('hex');
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
        case 'agent-ui-result':
          if (message.requestId) this.agentUiRequests.get(message.requestId)?.(message);
          break;
        case 'ready':
          await this.sendInitialState();
          break;
        case 'toggle-agent-access':
          if (this.agentGrantPending) break;
          try {
            if (this.agentBridge && !(this.connected && !this.remoteAccessGranted)) this.revokeAgentAccess();
            else await CommanderPanel.enableAgentAccess(this.context);
          } finally {
            this.postAgentAccessState();
          }
          break;
        case 'connect':
          await this.connect(message.profile ?? {}, message.password ?? '');
          break;
        case 'disconnect':
          this.stopConnectionMonitor();
          this.advanceConnectionRevision();
          this.client.close();
          this.connected = false;
          await this.refresh();
          break;
        case 'forget-connection':
          await this.forgetConnection(message.profile);
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
      await this.sendListings(undefined, message.type !== 'connect').catch(() => undefined);
    }
  }

  private async sendInitialState(): Promise<void> {
    await this.loadSavedProfiles();
    const last = readSavedProfiles([this.context.globalState.get<ConnectionProfile>(LAST_PROFILE_KEY)])[0];
    const profile = this.savedProfiles.find((saved) => last && profileIdentity(saved) === profileIdentity(last)) ?? this.savedProfiles.at(-1);
    if (!this.connected) this.profile = profile;
    const logoUri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'browser', 'assets', 'westbohemia-logo-animated-transparent-128.png');
    const logoUrl = this.panel.webview.asWebviewUri(logoUri).toString();
    this.post({ type: 'data', localPath: this.localPath, remotePath: this.remotePath, profile, savedProfiles: this.savedProfiles, connected: this.connected, logoUrl });
    this.postAgentAccessState();
    await this.refresh();
  }

  private async loadSavedProfiles(): Promise<void> {
    if (this.profilesLoaded) return;
    const stored = this.context.globalState.get<unknown>(SAVED_PROFILES_KEY);
    if (stored !== undefined) {
      this.savedProfiles = readSavedProfiles(stored);
    } else {
      this.savedProfiles = readSavedProfiles([this.context.globalState.get<unknown>(LAST_PROFILE_KEY)]);
      if (this.savedProfiles.length) await this.context.globalState.update(SAVED_PROFILES_KEY, this.savedProfiles);
    }
    this.profilesLoaded = true;
  }

  private async connect(rawProfile: Partial<ConnectionProfile>, suppliedPassword: string): Promise<void> {
    const profile = validateProfile(rawProfile);
    const passwordKey = getPasswordKey(profile);
    const password = suppliedPassword || await this.context.secrets.get(passwordKey) || '';
    if (this.disposed) return;
    if (!password) throw new Error('Enter the server password.');

    this.stopConnectionMonitor();
    this.advanceConnectionRevision();
    this.client.close();
    this.connected = false;
    if (profile.protocol === 'sftp') {
      let transport: SftpTransport;
      transport = new SftpTransport(this.context.secrets, (message, changed) => this.confirmSftpHostKey(message, changed), () => {
        if (this.client === transport) this.markConnectionLost();
      });
      this.client = transport;
    } else if (!(this.client instanceof FtpTransport)) {
      this.client = new FtpTransport(profile.protocol);
    }
    this.remotePath = await this.client.connect(profile, password);
    if (this.disposed) {
      this.client.close();
      return;
    }

    await this.loadSavedProfiles();
    const savedProfiles = addSavedProfile(this.savedProfiles, profile);
    if (savedProfiles !== this.savedProfiles) {
      await this.context.globalState.update(SAVED_PROFILES_KEY, savedProfiles);
      this.savedProfiles = savedProfiles;
    }
    this.profile = profile;
    this.connectionRevision++;
    this.connected = true;
    this.startConnectionMonitor();
    await this.context.globalState.update(LAST_PROFILE_KEY, profile);
    await this.context.secrets.store(passwordKey, password);
    this.post({ type: 'data', savedProfiles: this.savedProfiles });
    await this.refresh('Connected.');
  }

  private async forgetConnection(rawProfile: Partial<ConnectionProfile> | undefined): Promise<void> {
    await this.loadSavedProfiles();
    const requested = validateProfile(rawProfile ?? {});
    const identity = profileIdentity(requested);
    const saved = this.savedProfiles.find((profile) => profileIdentity(profile) === identity);
    if (!saved) throw new Error('This saved connection no longer exists.');
    if (this.disposed) return;
    const latest = readSavedProfiles(this.context.globalState.get<unknown>(SAVED_PROFILES_KEY));
    if (!latest.some((profile) => profileIdentity(profile) === identity)) throw new Error('This saved connection changed while confirmation was open.');
    const remaining = removeSavedProfile(latest, saved);
    await this.context.secrets.delete(getPasswordKey(saved));
    await this.context.globalState.update(SAVED_PROFILES_KEY, remaining);
    this.savedProfiles = remaining;
    const last = readSavedProfiles([this.context.globalState.get<unknown>(LAST_PROFILE_KEY)])[0];
    if (last && profileIdentity(last) === identity) await this.context.globalState.update(LAST_PROFILE_KEY, remaining.at(-1));
    this.post({ type: 'data', savedProfiles: remaining });
  }

  private async confirmSftpHostKey(message: string, changed: boolean): Promise<'trust' | 'replace' | undefined> {
    const action = changed ? 'Replace trusted key and connect' : 'Trust key and connect';
    const result = changed
      ? await vscode.window.showWarningMessage(`${message}\n\nVerify the new key before replacing the saved trust record.`, { modal: true }, 'Cancel', action)
      : await vscode.window.showWarningMessage(message, { modal: true }, action);
    if (result === action) return changed ? 'replace' : 'trust';
    return undefined;
  }

  private async navigate(pane: Pane | undefined, requestedPath: string | undefined): Promise<void> {
    if (!pane || !requestedPath) return;
    if (pane === 'local') {
      this.localRevision++;
      const targetPath = path.resolve(requestedPath);
      await fs.readdir(targetPath);
      if (this.disposed) return;
      this.localPath = targetPath;
    } else {
      this.requireConnection();
      this.remoteRevision++;
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
        `Replace ${conflicts.length} existing file${conflicts.length === 1 ? '' : 's'} in the ${source === 'local' ? 'remote' : 'local'} folder?\n\n${names.join('\n')}\n\nExisting folders will be merged.`,
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
        await this.client.ensureDir(target, this.remotePath);
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

    const remoteLabel = this.profile?.protocol === 'sftp' ? 'to the SFTP server' : 'to FTP';
    await this.reportTransfer(`Copied ${items.length} item${items.length === 1 ? '' : 's'} ${source === 'local' ? remoteLabel : 'to the local folder'}.`);
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
    const visit = async (sourcePath: string, relativePath: string, entry: RemoteEntry): Promise<void> => {
      validateCopyName(entry.name);
      if (entry.isSymbolicLink) throw new Error(`Cannot recursively copy remote symbolic link '${relativePath}'.`);
      if (entry.isDirectory) {
        items.push({ sourcePath, relativePath, kind: 'directory', size: 0 });
        for (const child of await this.client.list(sourcePath)) {
          if (child.name === '.' || child.name === '..') continue;
          await visit(posix.join(sourcePath, child.name), posix.join(relativePath, child.name), child);
        }
      } else if (entry.isFile) {
        const size = Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : await this.client.size(sourcePath);
        if (!Number.isFinite(size) || size < 0) throw new Error(`Could not determine the size of remote file '${relativePath}'.`);
        items.push({ sourcePath, relativePath, kind: 'file', size });
      } else {
        throw new Error(`Cannot copy unsupported remote item '${relativePath}'.`);
      }
    };

    for (const selectedPath of selected) {
      if (posix.dirname(selectedPath) !== directory) throw new Error('Select items from the current remote folder.');
      const entry = roots.find((candidate) => candidate.name === posix.basename(selectedPath));
      if (!entry) throw new Error(`Remote item '${posix.basename(selectedPath)}' no longer exists.`);
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
    const cache = new Map<string, RemoteEntry[]>();
    cache.set(root, await this.client.list(root));
    const directories = items.filter((item) => item.kind === 'directory').sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const item of directories) {
      const target = posix.join(root, ...item.relativePath.split('/'));
      const parent = posix.dirname(target);
      const entry = cache.get(parent)?.find((candidate) => candidate.name === posix.basename(target));
      if (entry) {
        if (entry.isSymbolicLink) throw new Error(`The remote destination '${item.relativePath}' is a symbolic link.`);
        if (!entry.isDirectory) throw new Error(`The remote destination '${item.relativePath}' is a file, not a folder.`);
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
      if (entry.isSymbolicLink) throw new Error(`The remote destination '${item.relativePath}' is a symbolic link.`);
      if (!entry.isFile) throw new Error(`The remote destination '${item.relativePath}' is a folder, not a file.`);
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
      await this.client.ensureDir(target, this.remotePath);
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
    if (posix.dirname(remotePath) !== normalizeRemotePath(this.remotePath)) throw new Error('Select a file in the current remote folder.');
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
      if (posix.dirname(target) !== normalizeRemotePath(this.remotePath)) throw new Error('The selected remote item is no longer in the open folder. Refresh and try again.');
      const entry = (await this.client.list(this.remotePath)).find((candidate) => posix.join(this.remotePath, candidate.name) === target);
      if (!entry || !this.profile) throw new Error('The selected remote item no longer exists. Refresh and try again.');

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
      this.post({ type: 'error', operation: 'open-file', error: `Could not read remote file '${posix.basename(remotePath)}': ${errorMessage(error)}` });
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private isGrantSessionCurrent(sessionId: string, connectionRevision: number): boolean {
    return CommanderPanel.current === this && !this.disposed && this.agentSessionId === sessionId && this.connectionRevision === connectionRevision;
  }

  private async grantAgentAccess(root: string, localRoot: string, expectedSessionId: string, grantRemote = true, expectedRevision = this.connectionRevision): Promise<void> {
    if (!this.isGrantSessionCurrent(expectedSessionId, expectedRevision)) throw new Error('The FTP session changed while access was being granted. Try again.');
    this.revokeAgentAccess();
    this.agentRoot = root;
    this.remoteAccessGranted = grantRemote;
    this.localAgentRoot = localRoot;
    this.localAgentGrantId = randomBytes(16).toString('hex');
    const bridge = new AgentBridge((request) => this.handleAgentRequest(request));
    this.agentBridge = bridge;
    try { await bridge.start(); }
    catch (error) {
      bridge.dispose();
      if (this.agentBridge === bridge) this.revokeAgentAccess();
      throw error;
    }
    if (!this.isGrantSessionCurrent(expectedSessionId, expectedRevision) || this.agentBridge !== bridge) {
      bridge.dispose();
      if (this.agentBridge === bridge) this.revokeAgentAccess();
      throw new Error('The FTP session changed while access was being granted. Try again.');
    }
    if (process.platform !== 'win32') {
      const runtimePaths = getCodexRuntimePaths(this.context.globalStorageUri.fsPath);
      if (await isCodexConfigured(runtimePaths.runtime)) {
        try {
          const record = await publishCodexGrant(runtimePaths.grants, bridge, expectedSessionId);
          if (!this.isGrantSessionCurrent(expectedSessionId, expectedRevision) || this.agentBridge !== bridge) {
            await removeCodexGrant(record);
            bridge.dispose();
            if (this.agentBridge === bridge) this.revokeAgentAccess();
            throw new Error('The FTP session changed while access was being granted. Try again.');
          }
          this.codexGrantFile = record;
        } catch (error) {
          if (!this.isGrantSessionCurrent(expectedSessionId, expectedRevision) || this.agentBridge !== bridge) throw error;
          void vscode.window.showWarningMessage(`FTP agent access is active in bm.ftp, but Codex could not be notified: ${errorMessage(error)}`);
        }
      }
    }
    CommanderPanel.agentAccessChanged.fire();
    this.postAgentAccessState();
    void vscode.window.showInformationMessage(`Agent access granted for ${grantRemote ? `FTP root ${root} and ` : ''}local root ${localRoot}.`);
  }

  private advanceConnectionRevision(): void {
    this.connectionRevision++;
    this.postAgentAccessState();
  }

  private revokeAgentAccess(): void {
    this.agentAccessRevision++;
    this.remoteAccessGranted = false;
    this.localAgentRoot = undefined;
    this.localAgentGrantId = '';
    void removeCodexGrant(this.codexGrantFile).catch(() => undefined);
    this.codexGrantFile = undefined;
    this.agentBridge?.dispose();
    this.agentBridge = undefined;
    CommanderPanel.agentAccessChanged.fire();
    this.postAgentAccessState();
  }

  private postAgentAccessState(): void {
    if (!this.disposed) this.post({ type: 'agent-access', agentAccessActive: Boolean(this.agentBridge && this.localAgentRoot), agentRemoteAccess: Boolean(this.agentBridge && this.localAgentRoot && this.remoteAccessGranted), agentAccessPending: this.agentGrantPending });
  }

  private getAgentServerDefinition(): vscode.McpStdioServerDefinition[] {
    if (!this.agentBridge) return [];
    const entry = path.join(this.context.extensionPath, 'mcp', 'server.mjs');
    return [new vscode.McpStdioServerDefinition(
      'bm.ftp', process.execPath, ['--ms-enable-electron-run-as-node', entry],
      { BM_FTP_AGENT_ENDPOINT: this.agentBridge.endpoint, BM_FTP_AGENT_TOKEN: this.agentBridge.token },
      '0.2.0'
    )];
  }

  private async handleAgentRequest(request: AgentRequest): Promise<unknown> {
    if (!this.agentBridge) throw new Error('Agent access has been revoked.');
    const bridge = this.agentBridge;
    const params = request.params;
    if (request.method === 'get_session') {
      return { sessionId: this.agentSessionId, mcpAvailable: true, connected: true, remoteConnected: this.connected, remoteAccessGranted: this.remoteAccessGranted, protocol: this.connected ? this.profile?.protocol : undefined, allowedRoot: this.agentRoot, localRoot: this.localAgentRoot, capabilities: [...(this.remoteAccessGranted ? ['list_directory', 'list_remote_directory', 'select_remote_files', 'search_files', 'read_file'] : []), ...(this.localAgentRoot ? ['get_local_pane', 'list_local_directory', 'select_local_files', 'find_local_directories', 'navigate_local', 'search_local_text_and_select', 'read_local_file'] : [])], limits: { maxDirectoryEntries: 1000, maxSearchDepth: 8, maxSearchDirectories: 2000, maxSearchResults: 1000, maxReadBytes: 1048576, maxReadLines: 400 } };
    }
    if (params.sessionId !== this.agentSessionId) throw new Error('The FTP session changed. Initialize the agent connection again.');
    if (request.method.startsWith('local_') || ['get_local_pane', 'list_local_directory', 'select_local_files', 'find_local_directories', 'navigate_local', 'search_local_text_and_select', 'read_local_file'].includes(request.method)) {
      return this.handleLocalAgentRequest(request.method, params, bridge);
    }
    const connectionRevision = this.connectionRevision;
    this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
    if (request.method === 'list_remote_directory' || request.method === 'select_remote_files') {
      return this.handleRemotePaneAgentRequest(request.method, params, bridge, connectionRevision);
    }
    if (request.method === 'list_directory') {
      return this.enqueue(async () => {
        this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
        const target = this.resolveAgentPath(String(params.path ?? '/'));
        await this.assertAgentDirectoryPath(target, bridge, params.sessionId, connectionRevision);
        const entries = mapRemoteEntries(await this.client.list(target), target).filter((entry) => isSafeRemoteName(entry.name));
        this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
        const limit = boundedInteger(params.limit, 200, 1, 1000);
        return { path: String(params.path ?? '/'), entries: entries.slice(0, limit).map(({ name, path: entryPath, kind, size, modifiedTime }) => ({ name, path: this.toAgentPath(entryPath), kind, size, modifiedTime })), truncated: entries.length > limit };
      });
    }
    if (request.method === 'search_files') {
      return this.enqueue(() => this.searchAgentFiles(params, bridge, connectionRevision));
    }
    if (request.method === 'read_file') {
      return this.enqueue(() => this.readAgentFile(params, bridge, connectionRevision));
    }
    throw new Error('Unknown agent operation.');
  }

  private resolveAgentPath(requested: string): string {
    return resolveGrantedRemotePath(this.agentRoot, requested);
  }

  private async handleRemotePaneAgentRequest(method: string, params: Record<string, unknown>, bridge: AgentBridge, connectionRevision: number): Promise<unknown> {
    const currentPath = this.remotePath;
    const revision = this.remoteRevision;
    const target = this.resolveAgentPath(typeof params.path === 'string' ? params.path : this.toAgentPath(currentPath));
    if (method === 'select_remote_files' && target !== currentPath) throw new Error('Selection is only allowed in the current remote folder.');
    const entries = await this.enqueue(async () => {
      this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
      await this.assertAgentDirectoryPath(target, bridge, params.sessionId, connectionRevision);
      const listing = await this.client.list(target);
      this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
      return listing.filter((entry) => isSafeRemoteName(entry.name) && !entry.isSymbolicLink && (entry.isFile || entry.isDirectory)).sort((a, b) => a.name.localeCompare(b.name));
    });
    if (method === 'list_remote_directory') {
      return { path: this.toAgentPath(target), entries: entries.slice(0, 1000).map((entry) => ({ name: entry.name, path: this.toAgentPath(posix.join(target, entry.name)), type: entry.isDirectory ? 'directory' : 'file' })), truncated: entries.length > 1000 };
    }
    const names = params.names;
    const filter = params.nameContains;
    if ((Array.isArray(names)) === (typeof filter === 'string')) throw new Error('Provide either names or nameContains.');
    if (Array.isArray(names) && (names.length === 0 || names.length > 1000 || names.some((name) => typeof name !== 'string' || !name || name.length > 255 || !isSafeRemoteName(name)))) throw new Error('Names must be basenames without path separators.');
    if (typeof filter === 'string' && (!filter || filter.length > 255 || /[\\/\0-\x1f\x7f]/.test(filter))) throw new Error('nameContains must be a basename substring without path separators.');
    const requestedNames = Array.isArray(names) ? new Set(names as string[]) : undefined;
    const matching = entries.filter((entry) => (entry.isFile || params.includeDirectories === true) && (requestedNames ? requestedNames.has(entry.name) : entry.name.toLocaleLowerCase().includes((filter as string).toLocaleLowerCase())));
    const paths = matching.slice(0, 1000).map((entry) => posix.join(target, entry.name));
    this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
    if (this.remoteRevision !== revision || this.remotePath !== currentPath) throw new Error('The remote pane changed; retry.');
    const result = await this.requestAgentUi({ action: 'select', pane: 'remote', expectedPath: currentPath, paths, includeDirectories: params.includeDirectories === true });
    this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
    if (this.remoteRevision !== revision || this.remotePath !== currentPath) throw new Error('The remote pane changed during selection; retry.');
    const allowed = new Set(paths);
    const selected = [...new Set((result.selectedPaths ?? []).filter((selectedPath) => allowed.has(selectedPath)))];
    const selectedPaths = selected.map((selectedPath) => this.toAgentPath(selectedPath));
    return { path: this.toAgentPath(target), selectedPaths, count: selectedPaths.length, truncated: matching.length > paths.length, ...(requestedNames ? { unmatchedNames: [...requestedNames].filter((name) => !selected.some((selectedPath) => posix.basename(selectedPath) === name)) } : {}) };
  }

  private async handleLocalAgentRequest(method: string, params: Record<string, unknown>, bridge: AgentBridge): Promise<unknown> {
    const root = this.localAgentRoot;
    if (!root) throw new Error('Local agent access has not been granted.');
    const grantId = this.localAgentGrantId;
    const deadline = Date.now() + 25000;
    const check = (): void => {
      this.requireAgentGrant(bridge, params.sessionId);
      if (this.localAgentRoot !== root || this.localAgentGrantId !== grantId) throw new Error('Local agent access has changed or been revoked.');
      if (Date.now() > deadline) throw new Error('Local agent operation timed out.');
    };
    check();
    if (method === 'get_local_pane') {
      const target = await this.resolveLocalAgentPath(root, this.localPath);
      check();
      return { path: target, revision: this.localRevision, root };
    }
    if (method === 'list_local_directory' || method === 'select_local_files') {
      const revision = this.localRevision;
      const currentPath = this.localPath;
      const target = await this.resolveLocalAgentPath(root, typeof params.path === 'string' ? params.path : currentPath);
      if (method === 'select_local_files') {
        const current = await this.resolveLocalAgentPath(root, currentPath);
        if (target !== current) throw new Error('Selection is only allowed in the current local folder.');
      }
      const entries = (await fs.readdir(target, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
        .sort((a, b) => a.name.localeCompare(b.name));
      check();
      if (method === 'list_local_directory') {
        return { path: path.relative(root, target) || '.', entries: entries.slice(0, 1000).map((entry) => ({ name: entry.name, path: path.relative(root, path.join(target, entry.name)), type: entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 1000 };
      }
      const names = params.names;
      const filter = params.nameContains;
      if ((Array.isArray(names)) === (typeof filter === 'string')) throw new Error('Provide either names or nameContains.');
      if (Array.isArray(names) && (names.length === 0 || names.length > 1000 || names.some((name) => typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)))) throw new Error('Names must be basenames without path separators.');
      if (typeof filter === 'string' && (!filter || filter.length > 255 || /[\\/\0\r\n]/.test(filter))) throw new Error('nameContains must be a basename substring without path separators.');
      const requestedNames = Array.isArray(names) ? new Set(names as string[]) : undefined;
      const matching = entries.filter((entry) => (entry.isFile() || params.includeDirectories === true) && (requestedNames ? requestedNames.has(entry.name) : entry.name.toLocaleLowerCase().includes((filter as string).toLocaleLowerCase())));
      const paths = matching.slice(0, 1000).map((entry) => path.join(target, entry.name));
      if (this.localRevision !== revision || this.localPath !== currentPath) throw new Error('The local pane changed; retry.');
      const result = await this.requestAgentUi({ action: 'select', expectedPath: currentPath, paths, includeDirectories: params.includeDirectories === true });
      check();
      if (this.localRevision !== revision || this.localPath !== currentPath) throw new Error('The local pane changed during selection; retry.');
      const allowed = new Set(paths);
      const selected = [...new Set((result.selectedPaths ?? []).filter((selectedPath) => allowed.has(selectedPath)))];
      const selectedPaths = selected.map((selectedPath) => path.relative(root, selectedPath));
      return { path: path.relative(root, target) || '.', selectedPaths, count: selectedPaths.length, truncated: matching.length > paths.length, ...(requestedNames ? { unmatchedNames: [...requestedNames].filter((name) => !selected.some((selectedPath) => path.basename(selectedPath) === name)) } : {}) };
    }
    if (method === 'find_local_directories') {
      const query = String(params.nameQuery ?? '').trim().toLocaleLowerCase();
      if (!query) throw new Error('Enter a directory name to search.');
      const maxDepth = boundedInteger(params.maxDepth, 5, 0, 8);
      const maxResults = boundedInteger(params.maxResults, 100, 1, 200);
      const pending = [{ directory: root, depth: 0 }];
      const matches: string[] = [];
      let visited = 0, skipped = 0, truncated = false;
      while (pending.length && visited < 500 && matches.length < maxResults) {
        check();
        const item = pending.shift()!;
        let entries: fsSync.Dirent[];
        try {
          await this.resolveLocalAgentPath(root, item.directory);
          entries = await fs.readdir(item.directory, { withFileTypes: true });
        } catch { skipped++; continue; }
        visited++;
        for (const entry of entries) {
          if (item.depth >= maxDepth) break;
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const target = path.join(item.directory, entry.name);
          if (entry.name.toLocaleLowerCase().includes(query)) matches.push(target);
          pending.push({ directory: target, depth: item.depth + 1 });
          if (matches.length >= maxResults || pending.length >= 2000) { truncated = true; break; }
        }
      }
      check();
      return { matches, visitedDirectories: visited, skipped, truncated: truncated || pending.length > 0 };
    }
    if (method === 'navigate_local') {
      const revision = this.localRevision;
      const oldPath = this.localPath;
      const target = await this.resolveLocalAgentPath(root, String(params.path ?? ''));
      const entries = this.addWorkspaceRelativePaths(await readLocalEntries(target));
      check();
      if (this.localRevision !== revision || this.localPath !== oldPath) throw new Error('The local pane changed; retry.');
      const result = await this.requestAgentUi({ action: 'navigate', expectedPath: oldPath, path: target, entries });
      check();
      if (this.localRevision !== revision || this.localPath !== oldPath) throw new Error('The local pane changed; retry.');
      this.localPath = target;
      this.localRevision++;
      return { path: target, revision: this.localRevision, selectedPaths: result.selectedPaths ?? [] };
    }
    if (method === 'search_local_text_and_select') {
      const revision = this.localRevision;
      const current = await this.resolveLocalAgentPath(root, this.localPath);
      const query = String(params.text ?? '');
      if (!query.trim() || query.length > 500) throw new Error('Enter a search text of up to 500 characters.');
      const sensitive = params.caseSensitive === true;
      const needle = sensitive ? query : query.toLocaleLowerCase();
      const entries = await fs.readdir(current, { withFileTypes: true });
      const matches: string[] = [];
      let checked = 0, skipped = 0, truncated = false;
      for (const entry of entries) {
        check();
        if (!entry.isFile() || entry.isSymbolicLink() || isSensitiveAgentFilename(entry.name)) { if (entry.isFile() || entry.isSymbolicLink()) skipped++; continue; }
        if (checked >= 500 || matches.length >= 200) { truncated = true; break; }
        checked++;
        const target = path.join(current, entry.name);
        try {
          const text = await this.readLocalAgentText(root, target);
          if ((sensitive ? text : text.toLocaleLowerCase()).includes(needle)) matches.push(target);
        } catch { skipped++; }
      }
      check();
      if (this.localRevision !== revision || this.localPath !== current) throw new Error('The local pane changed during the search; retry.');
      const result = await this.requestAgentUi({ action: 'select', expectedPath: current, paths: matches });
      check();
      if (this.localRevision !== revision || this.localPath !== current) throw new Error('The local pane changed during selection; retry.');
      return { path: current, selectedPaths: result.selectedPaths ?? [], matchedCount: matches.length, checked, skipped, truncated };
    }
    if (method === 'read_local_file') {
      const target = await this.resolveLocalAgentPath(root, String(params.path ?? ''));
      const content = await this.readLocalAgentText(root, target);
      check();
      const lines = content.split(/\r?\n/);
      const startLine = boundedInteger(params.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
      const maxLines = boundedInteger(params.maxLines, 200, 1, 400);
      const output = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
      const text = safeUtf8Prefix(output, 64 * 1024);
      return { path: target, text, startLine, truncated: startLine - 1 + maxLines < lines.length || text.length < output.length, encoding: 'utf-8' };
    }
    throw new Error('Unknown local agent operation.');
  }

  private async resolveLocalAgentPath(root: string, requested: string): Promise<string> {
    if (!requested || requested.includes('\0')) throw new Error('Enter a valid local path.');
    if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('The granted local root changed. Grant access again.');
    const target = path.resolve(root, requested);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the granted local root.');
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not available through local agent access.');
    }
    const real = await fs.realpath(target);
    const realRelative = path.relative(root, real);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Path is outside the granted local root.');
    return real;
  }

  private async readLocalAgentText(root: string, requested: string): Promise<string> {
    if (isSensitiveAgentFilename(path.basename(requested))) throw new Error('Sensitive file is blocked.');
    const target = await this.resolveLocalAgentPath(root, requested);
    const handle = await fs.open(target, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Only text files up to 1 MiB can be read.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > 1024 * 1024) throw new Error('File exceeded the read limit.');
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new Error('Binary file.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { await handle.close(); }
  }

  private async requestAgentUi(message: object): Promise<PanelMessage> {
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.agentUiRequests.delete(requestId); reject(new Error('The local pane did not acknowledge the request.')); }, 5000);
      this.agentUiRequests.set(requestId, (result) => {
        clearTimeout(timer);
        this.agentUiRequests.delete(requestId);
        if (!result.success) reject(new Error(result.error || 'The local pane rejected the request.'));
        else resolve(result);
      });
      this.post({ type: 'agent-ui', requestId, expiresAt: Date.now() + 4500, ...message });
    });
  }

  private toAgentPath(remotePath: string): string {
    return toGrantedRemotePath(this.agentRoot, remotePath);
  }

  private async searchAgentFiles(params: Record<string, unknown>, bridge: AgentBridge, connectionRevision: number): Promise<unknown> {
    const root = this.resolveAgentPath(String(params.path ?? '/'));
    await this.assertAgentDirectoryPath(root, bridge, params.sessionId, connectionRevision);
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
      this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
      const current = pending.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      const entries = (await this.client.list(current.path)).filter((entry) => isSafeRemoteName(entry.name));
      this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
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

  private async readAgentFile(params: Record<string, unknown>, bridge: AgentBridge, connectionRevision: number): Promise<unknown> {
    this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
    const target = this.resolveAgentPath(String(params.path ?? ''));
    const name = posix.basename(target);
    if (isSensitiveAgentFilename(name)) {
      throw new Error('This file is blocked because its name may identify credentials or a private key.');
    }
    await this.assertAgentDirectoryPath(posix.dirname(target), bridge, params.sessionId, connectionRevision);
    const listing = await this.client.list(posix.dirname(target));
    this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
    const file = listing.find((entry) => entry.name === name && !entry.isDirectory && !entry.isSymbolicLink);
    if (!file) throw new Error('The requested remote file was not found.');
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
        stream.destroy(new Error('Remote file exceeded the agent read limit.'));
        return;
      }
      chunks.push(buffer);
    });
    try { await this.client.downloadTo(stream, target); }
    catch (error) {
      if (oversized) {
        this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
        this.connected = false;
        this.stopConnectionMonitor();
        this.client.close();
        this.advanceConnectionRevision();
        this.post({ type: 'data', remotePath: this.remotePath, remoteEntries: [], profile: this.profile, connected: false, transfer: 'Server connection closed after an oversized agent read.' });
        throw new Error('File exceeded the 1 MiB read limit. The server connection closed to stop the transfer; reconnect before continuing.');
      }
      throw error;
    }
    this.requireRemoteAgentGrant(bridge, params.sessionId, connectionRevision);
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
    if (this.agentBridge !== bridge || sessionId !== this.agentSessionId || this.disposed) {
      throw new Error('Agent access has been revoked or the session changed.');
    }
  }

  private requireRemoteAgentGrant(bridge: AgentBridge, sessionId: unknown, connectionRevision: number): void {
    this.requireAgentGrant(bridge, sessionId);
    if (this.connectionRevision !== connectionRevision) throw new Error('The FTP connection changed during the request.');
    if (!this.connected) throw new Error('Remote FTP access is unavailable because the server is disconnected.');
    if (!this.remoteAccessGranted) throw new Error('Remote FTP agent access is not granted for this connection.');
  }

  private async assertAgentDirectoryPath(directory: string, bridge: AgentBridge, sessionId: unknown, connectionRevision: number): Promise<void> {
    let current = '/';
    for (const segment of directory.split('/').filter(Boolean)) {
      this.requireRemoteAgentGrant(bridge, sessionId, connectionRevision);
      const entry = (await this.client.list(current)).find((candidate) => candidate.name === segment);
      this.requireRemoteAgentGrant(bridge, sessionId, connectionRevision);
      if (!entry || !entry.isDirectory || entry.isSymbolicLink) throw new Error('The remote path is missing, is not a folder, or crosses a symbolic link.');
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
        this.post({ type: 'error', operation: 'remote-listing', error: `Remote folder: ${errorMessage(error)}` });
      }
    }
    this.post({
      type: 'data', remotePath: this.remotePath,
      remoteEntries, profile: this.profile, connected: this.connected
    });
  }

  private async sendListings(transfer?: string, includeProfile = true): Promise<void> {
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
        this.post({ type: 'error', operation: 'remote-listing', error: `Remote folder: ${errorMessage(error)}` });
      }
    }

    this.post({
      type: 'data', remotePath: this.remotePath,
      remoteEntries, ...(includeProfile ? { profile: this.profile } : {}), connected: this.connected, transfer
    });
  }

  private requireConnection(): void {
    if (!this.connected) throw new Error('Connect to a server first.');
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
      await this.client.checkHealth();
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
    this.advanceConnectionRevision();
    this.post({
      type: 'data', remotePath: this.remotePath, remoteEntries: [], profile: this.profile,
      connected: false, transfer: `${this.profile?.protocol === 'sftp' ? 'SFTP' : 'FTP'} connection lost. Click Connect to reconnect.`
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

function mapRemoteEntries(entries: RemoteEntry[], directory: string): FileEntry[] {
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
  return error instanceof Error ? error.message : 'An unknown remote server error occurred.';
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
