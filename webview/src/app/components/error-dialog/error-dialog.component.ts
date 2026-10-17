import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, ViewChild } from '@angular/core';
import { keepModalKeyboardFocus } from '../../modal-keyboard';

@Component({
  selector: 'bm-error-dialog',
  standalone: true,
  templateUrl: './error-dialog.component.html',
  styleUrl: './error-dialog.component.css'
})
export class ErrorDialogComponent implements AfterViewInit, OnDestroy {
  @Input() title = 'Operation failed';
  @Input() message = '';
  @Input() hint = '';
  @Output() dismissed = new EventEmitter<void>();
  @ViewChild('confirmButton') private confirmButton?: ElementRef<HTMLButtonElement>;
  private previousFocus: HTMLElement | undefined;

  ngAfterViewInit(): void {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.confirmButton?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  handleKeydown(event: KeyboardEvent): void {
    keepModalKeyboardFocus(event, () => this.confirmButton?.nativeElement.focus(), () => this.dismissed.emit());
  }
}
