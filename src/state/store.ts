/** Минимальный реактивный стор. Ничего внешнего — весь state живёт в памяти вкладки. */
export type Listener<T> = (state: T) => void;
export type Unsubscribe = () => void;

export class Store<T> {
  private state: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  /** Заменить state целиком. */
  set(next: T): void {
    this.state = next;
    this.emit();
  }

  /** Мутировать state на месте и разослать уведомление. */
  update(mutator: (state: T) => void): void {
    mutator(this.state);
    this.emit();
  }

  /** Уведомить подписчиков без изменения ссылки (после внешней мутации). */
  touch(): void {
    this.emit();
  }

  subscribe(listener: Listener<T>, immediate = false): Unsubscribe {
    this.listeners.add(listener);
    if (immediate) listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
