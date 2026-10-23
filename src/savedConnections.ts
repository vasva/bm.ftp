import { ConnectionProfile, getPasswordKey, validateProfile } from './core';

export const SAVED_PROFILES_KEY = 'bm.ftp.savedProfiles.v1';
export const LAST_PROFILE_KEY = 'bm.ftp.profile';

export function profileIdentity(profile: ConnectionProfile): string {
  return getPasswordKey(profile);
}

export function readSavedProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: ConnectionProfile[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Partial<ConnectionProfile>;
      if (typeof record.host !== 'string' || typeof record.username !== 'string'
        || typeof record.port !== 'number'
        || (record.protocol !== 'ftp' && record.protocol !== 'ftps' && record.protocol !== 'sftp')) continue;
      const profile = validateProfile(record);
      const identity = profileIdentity(profile);
      if (seen.has(identity)) continue;
      profiles.push(profile);
      seen.add(identity);
    } catch {
      // Ignore invalid persisted records without affecting valid connections.
    }
  }
  return profiles;
}

export function addSavedProfile(profiles: ConnectionProfile[], profile: ConnectionProfile): ConnectionProfile[] {
  return profiles.some((saved) => profileIdentity(saved) === profileIdentity(profile))
    ? profiles
    : [...profiles, profile];
}

export function removeSavedProfile(profiles: ConnectionProfile[], profile: ConnectionProfile): ConnectionProfile[] {
  const identity = profileIdentity(profile);
  return profiles.filter((saved) => profileIdentity(saved) !== identity);
}
