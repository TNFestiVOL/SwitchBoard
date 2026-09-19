import { EventEmitter } from 'node:events';

export interface ChangeEvent {
  kind: string;
  taskId?: number;
}

export class EventBus extends EventEmitter {
  change(e: ChangeEvent): void {
    this.emit('change', e);
  }

  onChange(fn: (e: ChangeEvent) => void): void {
    this.on('change', fn);
  }

  offChange(fn: (e: ChangeEvent) => void): void {
    this.off('change', fn);
  }
}
