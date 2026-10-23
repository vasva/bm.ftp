# Saved connection profiles: analysis

## Requested behavior

Remember the server address, effective port, username, and protocol for each successful FTP, FTPS, or SFTP connection. A failed attempt must not create a saved entry. The connection bar should let the user choose a saved entry or remove one after explicit confirmation. Use the Google Material Symbols already used by the webview. Keep the current connection workflow and stored passwords working.

## Current implementation

- `src/core.ts` defines and validates `ConnectionProfile` as `{ host, port, username, protocol }`. `getPasswordKey` identifies a password by the same four fields, with the host lowercased.
- `src/commanderPanel.ts` reads one last-used profile from `globalState['bm.ftp.profile']` on `ready`. After `client.connect` succeeds, it updates that key and stores the password in VS Code SecretStorage. FTP/FTPS and SFTP both follow this path. Validation, authentication, and SFTP host-key rejection happen before the updates.
- The Angular connection bar shows the saved-profile popup when profiles exist, with a delete action on every row. It also has a protocol popup and disables connection fields while connected. The webview loads Google Material Symbols in `webview/src/index.html`.
- Forgetting a saved connection opens an accessible Angular confirmation dialog before the webview sends the request. The host revalidates the requested profile, then removes its password secret and saved profile. File-operation confirmations still use VS Code host dialogs. Webview messages are serialized through `OperationQueue`. The `sendListings` response includes the previous successful profile, so a failed attempt after a prior success can reset the form to the old profile; avoid that for failed `connect` messages.

## Storage and identity

Use a versioned `globalState` key, for example `bm.ftp.savedProfiles.v1`, containing only validated `ConnectionProfile[]`. This is user-level extension state, so entries are available across workspaces. Never place a password or private key in this array. Keep the existing SecretStorage password behavior and per-host SFTP trust records. Deleting a saved entry should also delete its matching password secret; SFTP host trust is host-and-port scoped and can be shared by other usernames, so leave it intact.

Treat `(protocol, lowercased trimmed host, effective port, trimmed username)` as the identity. Preserve the username's case: usernames may be case-sensitive. `validateProfile` supplies an effective default port before comparison. Distinct protocols, ports, or usernames are distinct saved connections. A second successful login to the same identity must not create a duplicate, even if the host differs only in case. The existing profile values may be kept for display; do not invent separate profile names in this increment. Show a precise label such as `username@host:port · SFTP` so similar hosts stay distinguishable.

Read the saved array defensively: validate each entry, ignore malformed items and duplicates, and avoid modifying unrelated stored data. The old `bm.ftp.profile` is a last successful connection. When the new list key is absent, migrate that validated profile once and write the new list. An explicit empty new list must stay empty; it must not cause the old key to reappear. Keep the last-used form profile only when its identity exists in the saved list. When a user deletes it, clear or replace the old last-used key in the same confirmed action. Do not erase the legacy value before successful migration.

## Lifecycle and messages

1. On `ready`, send the saved profile list and the selected/last profile to the webview. Display the selector only when entries exist, plus the editable fields for a new connection. A selection copies all four profile fields into the form and clears the webview's password field, allowing the host to retrieve that profile's secret. Editing a profile identity should clear a password typed for another identity.
2. Keep the host authoritative for storage. On a successful `client.connect`, add the validated profile only if its identity is new, then update last-used profile and the password secret as the existing flow does. Send the updated list to the webview. A failed validation, password lookup, authentication, SFTP trust check, or SFTP initialization must leave the saved list untouched. Keep attempted fields in the form after failure so they can be corrected.
3. A delete icon beside each saved profile opens the webview confirmation dialog with the connection label and a notice that its password will also be removed. Cancel or Escape makes no change and sends no host request. On confirmation, the webview sends the exact profile identity. The host revalidates it, confirms it still exists in current saved state, removes only that entry and its matching password secret, and sends the new list. If the active connection matches, it may remain open for the current session; the saved entry stays deleted until a later successful connect. Never send an FTP/SFTP file-delete request for this UI action.
4. The selector and delete control should remain usable while disconnected; disable deletion while a connection operation or another modal action is pending. Give the icon button an accessible name and tooltip, such as `Forget saved connection`. Use existing `material-symbols-outlined` styling, with `delete` for removal and an appropriate connection icon for the selector label if useful. The current external font/CSP setup already permits Material Symbols.

## Implementation points

- Add small pure helpers for profile identity, saved-list validation/deduplication, and add/remove decisions alongside `ConnectionProfile` in `src/core.ts` or a focused `src/savedConnections.ts` module.
- Extend `PanelMessage` and `HostMessage` with saved-list data and a distinct `forget-connection` request. Keep profile persistence in `CommanderPanel`; never trust an unvalidated webview profile when deleting a secret.
- Extend `ConnectionBarComponent` inputs/outputs for saved profiles, selection, and forget request. Let `AppComponent` own the selected form fields, password reset, and accessible confirmation dialog. Keep host-side profile validation and persistence authoritative; only send a forget request after the user confirms in the webview.
- Update the mocked VS Code host in `test/commanderPanel.test.cjs` to keep globalState and SecretStorage in memory. Extend the Playwright bridge with a saved-list seed and host updates.

## Tests for Luna

- Pure/host tests: first successful FTP/FTPS/SFTP connection saved; failed authentication, rejected SFTP host key, and bad profile never saved; repeated success with equivalent host/port/username/protocol remains one entry; differing port/protocol/username create separate entries; old one-profile state migrates once; corrupt stored entries are ignored; deleting after confirmation removes only the selected profile and password, while cancel/dismiss changes nothing.
- Webview tests: saved list appears after `ready`; selecting each entry fills all four fields and clears a typed password; connect sends selected values and host can use the matching secret; deleting opens the HTML confirmation, cancel/Escape sends no request, and confirm removes only that entry and password; cover deleting a non-selected and last entry and prevent duplicate clicks while the host response is pending; empty list still allows manual connection; material icon and accessible button label render; failed connection keeps entered values for retry.
- Run the existing FTP/SFTP unit, loopback, and Playwright suites to catch regressions. Loopback tests should use local fixtures; do not contact user servers.
