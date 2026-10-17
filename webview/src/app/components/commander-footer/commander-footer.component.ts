import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'bm-commander-footer',
  standalone: true,
  templateUrl: './commander-footer.component.html',
  styleUrl: './commander-footer.component.css'
})
export class CommanderFooterComponent {
  @Input() status = '';
  @Input() error = '';
  @Input() canView = false;
  @Input() canCopy = false;
  @Input() canCreateFolder = false;
  @Input() canDelete = false;

  @Output() viewRequested = new EventEmitter<void>();
  @Output() copyRequested = new EventEmitter<void>();
  @Output() createFolderRequested = new EventEmitter<void>();
  @Output() deleteRequested = new EventEmitter<void>();
}
