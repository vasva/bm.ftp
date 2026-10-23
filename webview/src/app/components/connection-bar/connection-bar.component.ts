import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { formatSavedConnectionLabel, sameConnectionProfile } from '../../connection-profile';
import type { ConnectionProfile, ConnectionProfileField } from '../../connection-profile';

export type { ConnectionProfile, ConnectionProfileField } from '../../connection-profile';

@Component({
  selector: 'bm-connection-bar',
  standalone: true,
  templateUrl: './connection-bar.component.html',
  styleUrl: './connection-bar.component.css'
})
export class ConnectionBarComponent {
  savedMenuOpen = false;
  protocolMenuOpen = false;
  @Input() profile: ConnectionProfile = { host: '', port: 21, username: '', protocol: 'ftps' };
  @Input() password = '';
  @Input() connected = false;
  @Input() busy = false;
  @Input() logoUrl = '';
  @Input() savedProfiles: ConnectionProfile[] = [];

  @Output() profileChange = new EventEmitter<ConnectionProfile>();
  @Output() passwordChange = new EventEmitter<string>();
  @Output() connectRequested = new EventEmitter<void>();
  @Output() disconnectRequested = new EventEmitter<void>();
  @Output() savedProfileSelected = new EventEmitter<ConnectionProfile>();
  @Output() forgetRequested = new EventEmitter<ConnectionProfile>();

  get selectedSavedIndex(): string {
    const index = this.savedProfiles.findIndex((saved) => sameConnectionProfile(saved, this.profile));
    return index < 0 ? '' : String(index);
  }

  get selectedSavedLabel(): string {
    const index = Number(this.selectedSavedIndex);
    return this.selectedSavedIndex === '' ? 'Saved connections' : this.savedLabel(this.savedProfiles[index]);
  }

  savedLabel(profile: ConnectionProfile): string {
    return formatSavedConnectionLabel(profile);
  }

  toggleSavedMenu(): void {
    if (!this.busy && !this.connected) {
      this.protocolMenuOpen = false;
      this.savedMenuOpen = !this.savedMenuOpen;
    }
  }

  toggleProtocolMenu(): void {
    this.savedMenuOpen = false;
    this.protocolMenuOpen = !this.protocolMenuOpen;
  }

  selectProtocol(protocol: ConnectionProfile['protocol']): void {
    const oldDefault = this.profile.protocol === 'sftp' ? 22 : 21;
    const nextDefault = protocol === 'sftp' ? 22 : 21;
    const updated: ConnectionProfile = { ...this.profile, protocol };
    if (this.profile.port === oldDefault) updated.port = nextDefault;
    this.profileChange.emit(updated);
    this.protocolMenuOpen = false;
  }

  selectSaved(profile: ConnectionProfile): void {
    this.savedProfileSelected.emit({ ...profile });
    this.savedMenuOpen = false;
  }

  forgetSaved(profile: ConnectionProfile): void {
    this.savedMenuOpen = false;
    this.forgetRequested.emit({ ...profile });
  }

  @HostListener('document:click')
  closeSavedMenu(): void {
    this.savedMenuOpen = false;
    this.protocolMenuOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.savedMenuOpen = false;
    this.protocolMenuOpen = false;
  }

  updateProfile(field: ConnectionProfileField, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const updated: ConnectionProfile = { ...this.profile };
    if (field === 'port') updated.port = Number(value);
    else if (field === 'protocol') {
      const protocol = value === 'ftp' || value === 'ftps' || value === 'sftp' ? value : this.profile.protocol;
      this.selectProtocol(protocol);
      return;
    }
    else if (field === 'host') updated.host = value;
    else updated.username = value;
    this.profileChange.emit(updated);
  }
}
