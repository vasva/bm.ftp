import * as vscode from 'vscode';
import { CommanderPanel } from './commanderPanel';

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('bmFtp.open', () => {
    CommanderPanel.createOrShow(context);
  });

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.text = '$(folder) FTP Commander';
  statusBarItem.tooltip = 'Open bm.ftp FTP Commander';
  statusBarItem.command = 'bmFtp.open';
  statusBarItem.show();

  const enableAgentAccess = vscode.commands.registerCommand('bmFtp.enableAgentAccess', async () => {
    try {
      await CommanderPanel.enableAgentAccess();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not enable agent access.';
      void vscode.window.showErrorMessage(message);
    }
  });
  const revokeAgentAccess = vscode.commands.registerCommand('bmFtp.revokeAgentAccess', () => {
    CommanderPanel.revokeAgentAccess();
    void vscode.window.showInformationMessage('Read-only agent access revoked.');
  });
  const copyCodexConfiguration = vscode.commands.registerCommand('bmFtp.copyCodexConfiguration', async () => {
    try {
      await CommanderPanel.copyCodexConfiguration(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not prepare the Codex MCP configuration.';
      void vscode.window.showErrorMessage(message);
    }
  });
  const agentProvider = vscode.lm.registerMcpServerDefinitionProvider('bm.ftp.agents', {
    onDidChangeMcpServerDefinitions: CommanderPanel.agentAccessChanged.event,
    provideMcpServerDefinitions: () => CommanderPanel.getAgentServerDefinition()
  });

  context.subscriptions.push(command, enableAgentAccess, revokeAgentAccess, copyCodexConfiguration, statusBarItem, agentProvider, CommanderPanel.registerReadonlyDocuments());
}

export function deactivate(): void {
  CommanderPanel.close();
}
