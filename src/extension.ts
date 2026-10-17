import * as vscode from 'vscode';
import { CommanderPanel } from './commanderPanel';

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('bmFtp.open', () => {
    CommanderPanel.createOrShow(context);
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {
  CommanderPanel.close();
}
