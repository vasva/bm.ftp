# SFTP support: analysis and implementation specification

Date: 23 October 2026. Branch: `feature/sftp-support`.

Status: analysis for implementation. This document does not claim that SFTP is implemented or verified. Repository and library documentation were inspected; no tests were run while preparing this analysis.

## 1. Objective and current state

Add SFTP as a supported file-transfer protocol in the existing Commander workflow: connect, browse, create directories, view files, upload/download individual files and directory trees, confirm replacements, and report progress and failures. Exercise these operations against an ephemeral loopback SFTP server. Preserve existing FTP/FTPS behavior and the current uncommitted test work.

This requires product changes as well as tests. The present extension only supports FTP and explicit FTPS:

| Current boundary | Consequence for SFTP |
| --- | --- |
| [`src/core.ts`](../../src/core.ts) defines `Protocol` as `ftp | ftps`; `validateProfile` maps other values to FTPS. | An SFTP profile is currently misclassified rather than connected through SSH. |
| [`connection-bar.component.ts`](../../webview/src/app/components/connection-bar/connection-bar.component.ts) duplicates the two-protocol type, coerces the selector value, and uses port 21. | The UI cannot select or retain SFTP. |
| [`CommanderPanel`](../../src/commanderPanel.ts) constructs a `basic-ftp.Client` directly and consumes its `FileInfo` shape. | All remote operations are tied to one library. |
| The host resets the remote directory to `/`, uses FTP `NOOP`, and restores cwd after `ensureDir`. | Connection setup, health checks, and directory semantics need protocol-specific handling. |
| Remote View and the agent reader download into streams; transfers download into local staging files. | The replacement transport must support both destinations. |
| Existing [FTP protocol tests](../../test/ftpProtocolIntegration.test.cjs) use real `basic-ftp` over a local FTP fixture. | These provide an acceptance baseline, but do not establish any SFTP behavior. |

The browser tests already cover mkdir/copy message contracts and simulated progress. They cannot prove remote filesystem changes because their host bridge is mocked. The recent loopback FTP tests cover actual bytes, directory structure, replacements, cancellation, and integrity failures. Equivalent SFTP evidence must exercise the production SFTP adapter through the real host class.

## 2. SFTP scope and SSH boundaries

SFTP uses a file-transfer subsystem inside an authenticated SSH connection. Directory creation and copying must use SFTP operations. They do not require shell commands, an interactive terminal, a PTY, SCP, or remote execution of `mkdir`, `cp`, or `rm`.

The first implementation supports username/password authentication and explicit server host-key trust. SSH private keys, passphrases, agent forwarding, SSH config import, jump hosts, shell sessions, permission editing, and timestamp preservation are outside this increment. They must not be silently inferred from local SSH configuration.

FTPS remains FTP protected with TLS; it is not SFTP. Selecting SFTP must never fall back to FTP or FTPS after an error. The loopback SFTP fixture will reject shell, exec, forwarding, and PTY requests and record any attempted use.

## 3. Minimal transport architecture

Introduce one transport interface, a factory selected by the validated profile, and implementations for FTP/FTPS and SFTP. Keep the shared operation queue, copy planning, prompts, path validation, progress model, and replacement helpers in the existing host.

Suggested file boundaries:

| File | Responsibility |
| --- | --- |
| `src/remoteTransport.ts` | Protocol-independent entry/progress types and transport contract. |
| `src/ftpTransport.ts` | Wrap existing `basic-ftp` behavior with unchanged FTP/FTPS connection options. |
| `src/sftpTransport.ts` | SSH connection lifecycle, SFTP operations, entry normalization, and transfer progress. |
| `src/sftpHostKeys.ts` | Host-key identity, fingerprint formatting, trust lookup/prompt/persistence, and stale-attempt protection. |
| `src/commanderPanel.ts` | Select the transport and retain shared user/agent behavior. |

The contract must cover connection/open/close state, initial directory, listing, directory creation, upload, download to a local path or writable stream, file size, rename, file removal, recursive directory removal, and connection health. Remote entries need `name`, `size`, modification time, and explicit file/directory/symlink classification. The host should not import `basic-ftp.FileInfo` after this extraction.

All operation paths passed to the contract are absolute POSIX paths. Directory creation should leave the transport's externally observable location unchanged. The FTP adapter must contain the `ensureDir`/cwd-restoration detail; SFTP should not emulate an FTP CWD command in the shared host.

Preserve one serialized operation queue for UI and agent access. Do not introduce parallel directory transfers or a connection pool in this increment. Close the previous transport when reconnecting or switching protocol. An error, close, or timeout must settle pending promises and update state once; closing during a pending connection must prevent it from reopening later.

Use `ssh2` as a runtime dependency, with matching `@types/ssh2` development declarations. Its client and server APIs allow the same dependency to support production SFTP and a local test server. Confirm the selected version against the extension-host Node runtime and packaging before pinning it. The library documents host verification, keepalive settings, SFTP streams and file operations, and an SFTP-only server example. [ssh2 documentation](https://github.com/mscdex/ssh2), [SFTP API](https://github.com/mscdex/ssh2/blob/master/SFTP.md).

## 4. Protocol, profile, and port rules

1. Extend backend and webview protocol types to `ftp | ftps | sftp`. Recognize SFTP explicitly in profile validation and UI updates. An omitted protocol remains FTPS for compatibility; an explicitly unsupported value must produce a validation error rather than select a different transport.
2. Keep the existing host, port, username, and password controls. Label the selector as a connection protocol and add `SFTP (SSH)`. Provide protocol-appropriate server, connection, error, and transfer labels without redesigning the panel.
3. Defaults are port 21 for FTP/explicit FTPS and port 22 for SFTP. When changing protocol, replace a current old-protocol default with the new default. Preserve any nondefault port. Changing FTP to FTPS leaves port 21 unchanged.
4. A profile loaded from storage with an explicit port retains that port. Backend validation fills a missing port from the selected protocol and rejects invalid values outside integer range 1–65535. The UI must not silently convert invalid input to port 21.
5. Continue using VS Code SecretStorage for passwords. The existing `getPasswordKey` includes host, port, protocol, and username; preserve FTP/FTPS keys and ensure SFTP credentials remain distinct.
6. Copy Path must produce a credential-free `sftp://` URL for SFTP, including a nondefault port and properly encoded path segments. No password or trusted-host-key record is sent to the webview or agent bridge.

## 5. Host-key trust: TOFU and key changes

The SSH host key identifies the server, independently of the user's password. `ssh2` documents automatic acceptance when `hostVerifier` is omitted; the SFTP adapter must always configure an explicit verifier. [ssh2 hostVerifier option](https://github.com/mscdex/ssh2#client-methods).

Use trust on first use (TOFU) with a host-side VS Code confirmation. Derive an OpenSSH-style `SHA256:` fingerprint from the raw public host-key bytes; display the key algorithm and full fingerprint. Do not compare abbreviated fingerprints.

Store a versioned trust record in extension-owned SecretStorage under a dedicated SFTP host-key namespace. The key is based on canonical hostname and port, not username or workspace path. Normalize hostname casing and handle IPv6 without conflating different hosts or DNS aliases. Store the accepted public key or full fingerprint plus algorithm, host, port, and acceptance timestamp. This record contains no password. Do not write trust records into the repository, workspace settings, or the user's `~/.ssh/known_hosts`.

| Trust state | Required behavior |
| --- | --- |
| No stored key | Show host, port, algorithm, and fingerprint. Continue only after explicit **Trust key and connect**; dismissal/cancel rejects the connection. |
| Presented key matches the stored key | Continue without another prompt. |
| Presented key differs | Keep the old record. Show an explicit warning containing both old and new fingerprints and explain that a server change or interception is possible. Default action is cancel. Replacement requires the distinct **Replace trusted key and connect** action after the user verifies the change. |
| Stored record is malformed or unreadable | Reject the attempt with a recoverable explanation; do not silently treat it as a trusted or new host. |

The trust decision occurs during the SSH handshake before password authentication. Stage an accepted candidate key for that connection attempt. Persist it only after SSH authentication and SFTP subsystem initialization succeed, and before allowing file operations. If persistence fails, close the connection and report the failure. A rejected login, rejected subsystem, or cancelled/stale attempt must not replace an existing trusted key.

Bind each prompt and pending candidate to a connection-attempt generation and exact host/port. Recheck it after every await. Panel disposal, reconnect, or protocol change invalidates the decision. Re-read the stored record before committing; if another attempt changed the record, do not overwrite the newer observed decision without reevaluation. Test a storage change during a pending prompt. Cross-process SecretStorage updates are not a transactional compare-and-swap mechanism; do not claim stronger concurrency guarantees than implemented.

Trust confirmation runs in the extension host, not in a synthetic webview message. Cancellation must leave no connected SFTP session, no trust-store mutation, and no password-authentication attempt. A key-change test must prove these properties rather than merely check an error string.

## 6. Initial directory and path behavior

On successful SFTP initialization, resolve `.` with SFTP `realpath` and use that absolute path as the initial remote directory. Retain the server's actual path, such as `/home/tester`, instead of inventing a virtual `/`. The initial home is a starting location, not a new application sandbox; ordinary user navigation remains subject to server permissions. Parent navigation stops at POSIX `/`.

Continue using POSIX path operations for every remote path on all client operating systems. Use Windows/macOS path operations only for local destinations. Preserve spaces and Unicode names in listing and transfer requests. Existing local filename restrictions and case/normalization collision checks remain in force for downloads.

Normalize SFTP attributes into the shared entry type: mode identifies file/directory/symlink, size remains bytes, and timestamps are converted into the representation expected by the UI. Preserve symlink identity using appropriate SFTP metadata rather than following a link and reporting it as an ordinary directory. Recursive copy and agent traversal must keep their existing refusal to follow remote symlinks.

## 7. File operations and replacement semantics

### Mkdir and navigation

The existing VS Code name prompt remains the source of the folder name. Preserve trimming, validation, and cancellation. Create the target under the current remote directory, refresh that listing, and keep the visible directory unchanged. An existing directory may be accepted by recursive directory creation; an existing file or a denied mkdir must fail clearly. Do not create placeholder files for empty directories.

### Exact bytes, recursive transfers, and progress

Retain the current copy manifest and conflict scan. Selected root items are sent once from the browser; the host enumerates descendants. Preserve nested files, empty directories, zero-byte files, and unrelated destination entries when merging directories. Refuse unsupported types and symlinks consistently with existing FTP behavior.

The SFTP adapter must await successful transfer completion, including relevant remote acknowledgments/handle closure, before reporting success and checking destination size. Upload into the existing randomized remote staging path; download into the existing local staging file. Count actual transferred bytes and retain the existing progress direction, phase, byte totals, and item counts. Directories count as items but contribute no bytes. Zero-byte transfers must still complete without NaN or misleading stuck progress.

Tests compare source and destination buffers exactly. Product integrity validation remains size-based unless a separate checksum feature is introduced: equal sizes do not prove equal content. This increment must not claim remote checksum verification.

### Replacement, cancellation, and errors

Keep the current one-prompt conflict confirmation and post-prompt conflict recheck. Cancelling a replacement must happen before upload/download begins, preserve source and destination trees, and restore usable UI state.

Reuse [`replaceRemoteFile`](../../src/core.ts) for staged remote upload, backup, promotion, rollback, and cleanup, and `downloadAtomically` for local replacement. Map SFTP rename/remove failures into these existing semantics. Generic SFTP rename must not be assumed to replace an existing target. OpenSSH POSIX rename is an optional extension; it is not required for the initial implementation and must have explicit capability handling if introduced. [ssh2 rename APIs](https://github.com/mscdex/ssh2/blob/master/SFTP.md).

The backup/promotion sequence is not a gapless transaction, and a recursive copy is not atomic as a whole. Earlier completed items can remain after failure. Report partial completion accurately; preserve the original file for a failed replacement where rollback succeeds, and report the preserved backup path if rollback fails. Clear progress and remove disposable staging files without deleting an original/backup needed for recovery.

The transport must also implement the existing remove-file and recursive-remove operations safely, because the panel exposes Delete for connected sessions. Recursive removal must not follow symlinks. File removal is also required for staging cleanup even when no user deletion is requested.

## 8. FTP/FTPS and agent compatibility

- Preserve FTP/FTPS authentication options, TLS validation, default ports, stored profiles, password keys, and current directory behavior. Run the existing fake-client and real loopback FTP tests after extracting the adapter.
- Keep nonfatal operation errors distinct from connection loss. A denied directory operation must not falsely mark a usable SSH connection offline. Use SSH lifecycle/keepalive behavior for SFTP health; never send FTP `NOOP` over SSH.
- Preserve remote View as a read-only document and support bounded stream reads for agents.
- Preserve explicit agent grants, root-relative paths, size/line/result limits, sensitive-file filtering, symlink restrictions, session IDs, and revocation on disconnect/profile change/panel disposal. Selecting SFTP grants no agent access automatically.
- Return the real selected protocol in existing session metadata. Agent tools remain the same read-only tools; no shell/exec capability is introduced.
- Validate the agent's root restriction against real SFTP paths. Starting in a home directory must not accidentally expand a grant to filesystem `/`.

## 9. Test plan

### Unit and host contract tests

| Priority / ID | Scenario | Acceptance criteria |
| --- | --- | --- |
| P0 / U1 | Protocol and port rules | FTP/FTPS behavior remains stable; SFTP stays SFTP, defaults to 22, preserves custom ports, and rejects unsupported protocols/invalid ports. |
| P0 / U2 | Transport selection and lifecycle | Each profile selects the correct adapter; reconnect closes the previous one; dispose during connect/trust prompt cannot reopen a session. |
| P0 / U3 | Host-key decisions | Unknown/matching/changed keys, cancellation, storage errors, and stale prompts follow section 5. Failed authentication does not commit a candidate key. |
| P0 / U4 | Credential and trust identities | Password identity includes protocol/user; host-key identity includes canonical host/port independently of user. Existing FTP keys remain valid. |
| P0 / U5 | Entry/path normalization | File types, symlinks, sizes, timestamp conversion, non-root home, POSIX paths, and encoded SFTP URLs are correct. |
| P1 / U6 | Error and replacement behavior | Typed permission/missing-file failures remain recoverable; lost channels reject pending work; promotion/rollback/cleanup errors preserve existing recovery behavior. |
| P0 / U7 | Agent compatibility | Root restrictions, symlink refusal, bounded reads, and grant revocation work through the shared transport. |

Reuse the existing selection, atomic-download, remote-replacement, validation, and copy-planning tests. Add adapter-specific cases where protocol behavior introduces new evidence rather than repeating every shared helper assertion.

### Real loopback SFTP integration

Add `test/sftp/loopback-server.cjs` and `test/sftpProtocolIntegration.test.cjs`. Drive the real `CommanderPanel` and production SFTP adapter; mock only VS Code APIs and prompt answers. Bind the SSH listener to `127.0.0.1` on an ephemeral port, use test-only credentials and host keys, and isolate every test's remote state and local temporary workspace. No external SSH/FTP account is involved.

The fixture must implement the SFTP operations used by the adapter: path resolution and directory listing, attributes, file open/read/write/close, mkdir, rename, file removal, and rmdir. Honor handles, offsets, EOF, create/truncate flags, and failure status codes. Support deterministic permission, short-transfer, metadata, and rename failures. Close all channels, sockets, and listeners at teardown. Reject shell/exec/PTY/forwarding requests. [SFTP server request API](https://github.com/mscdex/ssh2/blob/master/SFTP.md).

| Priority / ID | Scenario | Acceptance criteria |
| --- | --- | --- |
| P0 / S1 | Trusted connection and browse | Known fixture host key, password login, initial non-root home, listing, navigation, remote View, and disconnect succeed through the actual adapter. |
| P0 / S2 | Host key and authentication failures | Rejected unknown/changed key prevents password authentication; wrong password does not commit trust; a later permitted attempt succeeds. |
| P0 / S3 | Mkdir and cancellation | Folder is created under the active directory and listed; cancelled prompt changes nothing; denied creation yields an error and leaves the connection usable. |
| P0 / S4 | Single-file transfers | Upload/download preserve exact binary bytes and zero-byte files; final progress is complete; no staging files remain. |
| P0 / S5 | Recursive transfers | Both directions preserve the complete nested tree, empty directories, zero-byte files, selected sibling roots, and unrelated destination files; totals match the manifest. |
| P0 / S6 | Replacement accepted/cancelled | One conflict prompt; cancel causes no transfer and preserves originals; accept yields exact bytes and cleans staging/backup artifacts in both directions. |
| P0 / S7 | Transfer/size failure | Original destination survives a failed replacement; error and progress cleanup occur; later operations work when the connection remains live. |
| P1 / S8 | Promotion and rollback failure | Failed promotion restores the old file; failed rollback leaves the recoverable backup and reports its path. No whole-tree rollback is assumed. |
| P1 / S9 | Connection loss and retry | Interrupted channel rejects in-flight work, updates offline state, revokes grants, and allows a fresh connection without stale progress. |
| P0 / S10 | Symlink and operation boundaries | Recursive copy/agent traversal refuse links; cleanup/delete cannot traverse them; fixture observes no shell/exec requests. |

The loopback server proves protocol interaction with the selected library; it is not evidence of compatibility with every deployed OpenSSH/SFTP implementation. A separate OpenSSH compatibility run can follow when a concrete target is available.

### Playwright webview contracts

Extend [`test/e2e/commander.spec.ts`](../../test/e2e/commander.spec.ts) and its existing controlled bridge. Keep protocol interactions explicit through host messages.

| Priority / ID | Scenario | Acceptance criteria |
| --- | --- | --- |
| P0 / W1 | SFTP profile selection | The selector retains SFTP; default/custom port rules hold; connect message carries exact protocol, host, port, user, and test password. |
| P0 / W2 | Connect/error/retry | Pending state, host error, dismissal, and retry preserve the selected SFTP profile and restore usable controls. |
| P0 / W3 | Mkdir and copy contracts | Parameterize existing remote mkdir and both copy directions for SFTP; selected root paths are sent once without flattening; disconnected actions remain disabled. |
| P0 / W4 | Progress, cancellation, and errors | SFTP/remote labels, upload/download phases, completion, cancellation, and failure recovery reflect host messages correctly. |
| P1 / W5 | Path/context behavior | Navigation uses absolute SFTP paths; copy-path request identifies the correct pane/item; profile changes do not reuse stale remote selection. |

Host-key trust and native replacement/name prompts belong to host tests. A browser mock cannot validate them or prove that files were transferred.

## 10. Implementation sequence and verification

1. Preserve the existing FTP test changes on `feature/sftp-support`; use this analysis as the implementation boundary.
2. Introduce the narrow transport contract and FTP wrapper. Adapt the host without changing transfer policies, then establish the FTP/FTPS regression baseline.
3. Add profile/default-port handling and the host-key trust component, including its decision/lifecycle unit tests.
4. Implement SFTP connection, initial-home resolution, normalized listing, streams, mkdir, transfer, rename/remove, and connection-state behavior.
5. Add the isolated SFTP fixture and P0 protocol scenarios. Fix failures at their actual layer; do not replace real protocol assertions with mocks to obtain passing results.
6. Extend Playwright profile/action contracts and protocol labels. Review the product and test changes before final verification.
7. Run focused unit/host and SFTP tests, then the existing FTP regression suite and complete Playwright suite. Rerun affected checks after corrections. Finish with the requested visible, slow, single-worker browser demonstration.

Expected commands once the proposed files exist:

```sh
npm run compile:extension
node --test test/sftpProtocolIntegration.test.cjs
node --test test/ftpProtocolIntegration.test.cjs
npm test
npm run test:e2e -- --workers=1
```

`npm test` currently includes `test/*.test.cjs`, so a new top-level SFTP protocol test participates automatically. The existing Playwright environment controls select the local Chrome executable, headed mode, and slow motion. Normal verification should use deterministic response gates and assertions; slow motion is for demonstration.

## 11. Acceptance gate and risks

Implementation is accepted when SFTP is selectable and uses the real transport; host-key trust and changed-key decisions follow this specification; mkdir, exact-byte/recursive transfers, replacement/cancellation, progress, and failure cleanup pass against loopback; FTP/FTPS and existing agent policies retain their behavior; and Playwright proves the corresponding UI contracts. Report mocked UI, real FTP, and real SFTP results separately. Do not report an external-server validation unless one was actually performed.

Key risks to resolve during implementation:

- **Trust races and stale prompts:** an obsolete decision must not authorize a new profile or overwrite a newly observed pin. TOFU confirms continuity after first acceptance; it does not independently establish the identity of an unknown first server.
- **Path and symlink semantics:** SFTP home may differ from `/`; metadata must retain link identity, and agent root enforcement must survive adapter normalization.
- **Transfer completion and rename differences:** byte delivery/acknowledgment, remote handle closure, size checks, rollback, and cleanup must be awaited and failure-tested. Do not assume optional OpenSSH extensions.
- **Protocol health:** permissions and missing files are not connection-loss signals. SSH close/error events must not leave the UI or shared queue stuck.
- **Packaging/runtime:** ship the runtime SFTP dependency and verify its optional native components do not make VSIX installation dependent on development tooling. Current `.vscodeignore` excludes `docs/**`, but this requested analysis is under `doc/**`; review that packaging rule before publishing a VSIX.
- **Coverage limits:** fixture interoperability and size validation are bounded evidence. Private-key authentication, external servers, shell execution, whole-tree atomicity, and remote checksums are not covered by this increment.

## 12. Sources

- Repository source and tests linked above; inspected on 23 October 2026.
- [basic-ftp project documentation](https://github.com/patrickjuchli/basic-ftp): FTP/FTPS capabilities and existing client boundary.
- [ssh2 project documentation](https://github.com/mscdex/ssh2): SSH client/server, host verification, lifecycle, and SFTP-only server example.
- [ssh2 SFTP API](https://github.com/mscdex/ssh2/blob/master/SFTP.md): file/directory operations, streams, server requests, and optional OpenSSH extensions.
