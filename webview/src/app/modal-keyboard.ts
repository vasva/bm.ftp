export interface ModalKeyEvent {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export function blockBackgroundKeydown(modalOpen: boolean, event: Pick<ModalKeyEvent, 'preventDefault'>): boolean {
  if (!modalOpen) return false;
  event.preventDefault();
  return true;
}

export function keepModalKeyboardFocus(event: ModalKeyEvent, focus: () => void, dismissOnEscape?: () => void): void {
  event.stopPropagation();
  if (event.key === 'Escape' && dismissOnEscape) {
    event.preventDefault();
    dismissOnEscape();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    focus();
  }
}
