export interface ConnectionProfile {
  host: string;
  port: number;
  username: string;
  protocol: 'ftp' | 'ftps' | 'sftp';
}

export type ConnectionProfileField = keyof ConnectionProfile;

export function sameConnectionProfile(left: ConnectionProfile, right: ConnectionProfile): boolean {
  return left.host.trim().toLowerCase() === right.host.trim().toLowerCase()
    && left.port === right.port
    && left.username.trim() === right.username.trim()
    && left.protocol === right.protocol;
}

export function formatSavedConnectionLabel(profile: ConnectionProfile): string {
  return `${profile.username}@${formatHost(profile.host)}:${profile.port} · ${profile.protocol.toUpperCase()}`;
}

export function formatForgetConnectionMessage(profile: ConnectionProfile): string {
  return `Forget saved connection ${profile.username}@${formatHost(profile.host)}:${profile.port} (${profile.protocol.toUpperCase()})? Its saved password will also be removed.`;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
