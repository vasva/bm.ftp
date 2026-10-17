import { Component, EventEmitter, Input, Output } from '@angular/core';
import { buildPathParts, PathPane, PathPart } from './path-parts';

@Component({
  selector: 'bm-path-bar',
  standalone: true,
  templateUrl: './path-bar.component.html',
  styleUrl: './path-bar.component.css'
})
export class PathBarComponent {
  @Input({ required: true }) pane!: PathPane;
  @Input() path = '';
  @Input() loading = false;
  @Input() connected = true;
  @Output() pathSelected = new EventEmitter<string>();

  get parts(): PathPart[] {
    return buildPathParts(this.path, this.pane, this.connected);
  }

  selectPath(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.pathSelected.emit(path);
  }
}
