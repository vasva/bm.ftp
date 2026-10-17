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

  context.subscriptions.push(command, statusBarItem, CommanderPanel.registerReadonlyDocuments());
}

export function deactivate(): void {
  CommanderPanel.close();
}
