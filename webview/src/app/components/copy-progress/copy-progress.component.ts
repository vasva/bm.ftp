import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild } from '@angular/core';
import { keepModalKeyboardFocus } from '../../modal-keyboard';

export interface CopyProgress {
  direction: 'upload' | 'download';
  name: string;
  total: number;
  transferred: number;
  verified: number;
  totalItems: number;
  copiedItems: number;
  verifiedItems: number;
  phase: 'transfer' | 'verify';
}

@Component({
  selector: 'bm-copy-progress',
  standalone: true,
  templateUrl: './copy-progress.component.html',
  styleUrl: './copy-progress.component.css'
})
export class CopyProgressComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) progress!: CopyProgress;
  @ViewChild('dialog') private dialog?: ElementRef<HTMLElement>;
  private previousFocus: HTMLElement | undefined;

  ngAfterViewInit(): void {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.dialog?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  handleKeydown(event: KeyboardEvent): void {
    keepModalKeyboardFocus(event, () => this.dialog?.nativeElement.focus());
  }

  formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  progressPercent(value: number, total: number): number {
    if (total === 0) return 100;
    return Math.min(100, Math.round((value / total) * 100));
  }

  overallProgressPercent(progress: CopyProgress): number {
    if (progress.total === 0) {
      if (progress.totalItems === 0) return 100;
      return Math.round((progress.copiedItems + progress.verifiedItems) / (progress.totalItems * 2) * 100);
    }
    return Math.round((Math.min(progress.transferred, progress.total) + Math.min(progress.verified, progress.total)) / (progress.total * 2) * 100);
  }
}
