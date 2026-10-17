import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'bm-file-context-menu',
  standalone: true,
  templateUrl: './file-context-menu.component.html',
  styleUrl: './file-context-menu.component.css'
})
export class FileContextMenuComponent {
  @Input() x = 0;
  @Input() y = 0;
  @Input() remote = false;
  @Input() relativePathEnabled = false;

  @Output() copyRequested = new EventEmitter<boolean>();
  @Output() dismissed = new EventEmitter<void>();
}
