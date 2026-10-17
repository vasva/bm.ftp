import { Component, EventEmitter, Input, Output } from '@angular/core';

export type PaneHeaderKind = 'local' | 'remote';

@Component({
  selector: 'bm-pane-header',
  standalone: true,
  templateUrl: './pane-header.component.html',
  styleUrl: './pane-header.component.css'
})
export class PaneHeaderComponent {
  @Input({ required: true }) pane!: PaneHeaderKind;
  @Input() connected = false;
  @Output() refreshRequested = new EventEmitter<void>();
  @Output() parentRequested = new EventEmitter<void>();

  refresh(event: MouseEvent): void {
    event.stopPropagation();
    this.refreshRequested.emit();
  }

  goUp(event: MouseEvent): void {
    event.stopPropagation();
    this.parentRequested.emit();
  }
}
