import type { Page } from '@playwright/test';

export type BridgeMessage = Record<string, any>;

export const localEntries = [
  { name: 'Documents', path: '/workspace/Documents', kind: 'directory', size: 0, relativePath: 'Documents' },
  { name: 'alpha.txt', path: '/workspace/alpha.txt', kind: 'file', size: 12, relativePath: 'alpha.txt' },
  { name: 'beta.txt', path: '/workspace/beta.txt', kind: 'file', size: 8, relativePath: 'beta.txt' },
  { name: 'gamma.log', path: '/workspace/gamma.log', kind: 'file', size: 4, relativePath: 'gamma.log' }
];

export const remoteEntries = [
  { name: 'folder', path: '/folder', kind: 'directory', size: 0 },
  { name: 'alpha-remote.txt', path: '/alpha-remote.txt', kind: 'file', size: 18 },
  { name: 'beta-remote.txt', path: '/beta-remote.txt', kind: 'file', size: 7 }
];

export const vscodeThemeVariables = {
  '--vscode-font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
  '--vscode-editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
  '--vscode-foreground': '#9FADB1',
  '--vscode-editor-background': '#0f1c21',
  '--vscode-sideBar-background': '#0e171c',
  '--vscode-panel-border': '#0a1217',
  '--vscode-descriptionForeground': '#c2ced180',
  '--vscode-errorForeground': '#C13838',
  '--vscode-focusBorder': '#2f5867',
  '--vscode-input-background': '#13232a',
  '--vscode-input-foreground': '#c2ced1',
  '--vscode-input-border': '#2a4752',
  '--vscode-button-background': '#0187a680',
  '--vscode-button-foreground': '#1ad3fe',
  '--vscode-button-hoverBackground': '#0187a699',
  '--vscode-button-secondaryBackground': '#1a313a',
  '--vscode-button-secondaryForeground': '#c2ced1cc',
  '--vscode-button-secondaryHoverBackground': '#1f3a44',
  '--vscode-list-hoverBackground': '#2543514d',
  '--vscode-list-activeSelectionBackground': '#25435173',
  '--vscode-list-activeSelectionForeground': '#c2ced1',
  '--vscode-menu-background': '#15262e',
  '--vscode-menu-foreground': '#87aabb',
  '--vscode-menu-selectionForeground': '#e9eff2'
};

export interface WebviewSeed {
  connected?: boolean;
  remotePath?: string;
  remoteEntries?: typeof remoteEntries;
  localEntries?: typeof localEntries;
  savedProfiles?: Array<{ host: string; port: number; username: string; protocol: 'ftp' | 'ftps' | 'sftp' }>;
}

export async function installMockBridge(page: Page, seed: WebviewSeed = {}): Promise<void> {
  await page.addInitScript(({ seed, localEntries, remoteEntries, themeVariables }) => {
    const messages: BridgeMessage[] = [];
    const waiters: Array<{ type: string; resolve: (message: BridgeMessage) => void }> = [];
    const cursors = new Map<string, number>();
    const deliver = (message: BridgeMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
    const nextMessage = (type: string): Promise<BridgeMessage> => {
      const cursor = cursors.get(type) ?? 0;
      const index = messages.findIndex((message, candidate) => candidate >= cursor && message.type === type);
      if (index >= 0) {
        cursors.set(type, index + 1);
        return Promise.resolve(messages[index]);
      }
      return new Promise((resolve) => waiters.push({ type, resolve }));
    };

    const applyTheme = () => {
      if (!document.documentElement) return;
      for (const [name, value] of Object.entries(themeVariables)) document.documentElement.style.setProperty(name, value);
      document.documentElement.style.colorScheme = 'dark';
    };
    applyTheme();
    window.addEventListener('DOMContentLoaded', applyTheme, { once: true });

    (window as any).__bmFtpTest = {
      messages,
      deliver,
      nextMessage,
      getMessages: () => messages
    };
    (window as any).acquireVsCodeApi = () => ({
      postMessage(message: BridgeMessage) {
        messages.push(message);
        for (let index = waiters.length - 1; index >= 0; index--) {
          if (waiters[index].type === message.type) {
            const [{ resolve }] = waiters.splice(index, 1);
            cursors.set(message.type, messages.length);
            resolve(message);
          }
        }

        if (message.type === 'ready') {
          queueMicrotask(() => {
            deliver({
              type: 'data',
              localPath: '/workspace',
              remotePath: seed.remotePath ?? '/',
              logoUrl: '/assets/westbohemia-logo-animated-transparent-128.png',
              connected: seed.connected ?? false,
              savedProfiles: seed.savedProfiles ?? [],
              profile: seed.connected ? { host: 'ftp.example.test', port: 21, username: 'tester', protocol: 'ftp' } : undefined
            });
            deliver({ type: 'data', localEntries: seed.localEntries ?? localEntries });
            if (seed.connected) {
              deliver({
                type: 'data',
                remotePath: seed.remotePath ?? '/',
                remoteEntries: seed.remoteEntries ?? remoteEntries,
                connected: true
              });
            } else {
              deliver({ type: 'data', remoteEntries: [], connected: false });
            }
          });
        }
      },
      getState: () => undefined,
      setState: () => undefined
    });
  }, { seed, localEntries, remoteEntries, themeVariables: vscodeThemeVariables });
  await page.goto('/');
}

export function waitForHostMessage(page: Page, type: string): Promise<BridgeMessage> {
  return page.evaluate((messageType) => (window as any).__bmFtpTest.nextMessage(messageType), type);
}

export async function getHostMessages(page: Page, type?: string): Promise<BridgeMessage[]> {
  return page.evaluate((messageType) => {
    const messages = (window as any).__bmFtpTest.getMessages() as BridgeMessage[];
    return messageType ? messages.filter((message) => message.type === messageType) : messages;
  }, type);
}

export async function deliverHostMessage(page: Page, message: BridgeMessage): Promise<void> {
  await page.evaluate((hostMessage) => (window as any).__bmFtpTest.deliver(hostMessage), message);
}

export async function connectMockedFtp(page: Page): Promise<BridgeMessage> {
  await page.getByRole('textbox', { name: 'Server' }).fill('ftp.example.test');
  await page.getByRole('textbox', { name: 'Username' }).fill('tester');
  await page.getByLabel('Password').fill('test-password');
  const connect = waitForHostMessage(page, 'connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  return connect;
}

export async function markMockFtpConnected(page: Page): Promise<void> {
  await deliverHostMessage(page, {
    type: 'data',
    remotePath: '/',
    remoteEntries,
    connected: true,
    profile: { host: 'ftp.example.test', port: 21, username: 'tester', protocol: 'ftp' }
  });
}
