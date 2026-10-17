import { Component, EventEmitter, Input, Output } from '@angular/core';

export interface ConnectionProfile {
  host: string;
  port: number;
  username: string;
  protocol: 'ftp' | 'ftps';
}

export type ConnectionProfileField = keyof ConnectionProfile;

@Component({
  selector: 'bm-connection-bar',
  standalone: true,
  templateUrl: './connection-bar.component.html',
  styleUrl: './connection-bar.component.css'
})
export class ConnectionBarComponent {
  @Input() profile: ConnectionProfile = { host: '', port: 21, username: '', protocol: 'ftps' };
  @Input() password = '';
  @Input() connected = false;
  @Input() busy = false;
  @Input() logoUrl = '';

  @Output() profileChange = new EventEmitter<ConnectionProfile>();
  @Output() passwordChange = new EventEmitter<string>();
  @Output() connectRequested = new EventEmitter<void>();
  @Output() disconnectRequested = new EventEmitter<void>();

  updateProfile(field: ConnectionProfileField, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const updated: ConnectionProfile = { ...this.profile };
    if (field === 'port') updated.port = Number(value) || 21;
    else if (field === 'protocol') updated.protocol = value === 'ftp' ? 'ftp' : 'ftps';
    else if (field === 'host') updated.host = value;
    else updated.username = value;
    this.profileChange.emit(updated);
  }
}
