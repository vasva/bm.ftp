import * as posix from 'node:path/posix';

export function resolveGrantedRemotePath(root: string, requested: string): string {
  if (/[\\\0\r\n\x01-\x1f\x7f]/.test(requested)) throw new Error('FTP path contains an invalid character.');
  const target = posix.resolve(root, requested.replace(/^\/+/, ''));
  const relative = posix.relative(root, target);
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) throw new Error('Path is outside the granted FTP root.');
  return target;
}

export function isSafeRemoteName(name: string): boolean {
  return name !== '.' && name !== '..' && !/[\\/\0-\x1f\x7f]/.test(name);
}

export function toGrantedRemotePath(root: string, target: string): string {
  const relative = posix.relative(root, target);
  return relative ? `/${relative}` : '/';
}

export function isSensitiveAgentFilename(name: string): boolean {
  return /^(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ecdsa|ed25519)|.*(?:secret|credential|password|private[-_]?key).*)$/i.test(name)
    || /\.(?:key|pem|p12|pfx)$/i.test(name);
}
