/** Крошечный модальный диалог-форма. Без зависимостей, возвращает Promise со значениями полей. */

export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'select';
  value?: string;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export interface DialogOptions {
  title: string;
  fields: DialogField[];
  submitLabel?: string;
  destructiveLabel?: string;
}

let styleInjected = false;

function injectStyles(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .dlg-backdrop { position: fixed; inset: 0; background: rgba(6,9,14,.6); display: grid; place-items: center; z-index: 100; }
    .dlg { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px; width: min(420px, 92vw); padding: 16px; box-shadow: 0 18px 48px rgba(0,0,0,.5); }
    .dlg h2 { margin: 0 0 12px; font-size: 15px; }
    .dlg .field + .field { margin-top: 10px; }
    .dlg .field > span { display: block; color: var(--text-dim); font-size: 12px; margin-bottom: 3px; }
    .dlg .actions { display: flex; gap: 8px; margin-top: 16px; }
    .dlg .actions .spacer { flex: 1; }
  `;
  document.head.appendChild(style);
}

export function openForm(options: DialogOptions): Promise<Record<string, string> | null> {
  injectStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dlg-backdrop';

    const dialog = document.createElement('form');
    dialog.className = 'dlg';
    dialog.innerHTML = `<h2></h2>`;
    dialog.querySelector('h2')!.textContent = options.title;

    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

    for (const field of options.fields) {
      const wrapper = document.createElement('label');
      wrapper.className = 'field';
      const caption = document.createElement('span');
      caption.textContent = field.label;
      wrapper.appendChild(caption);

      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.value = field.value ?? '';
      } else if (field.type === 'select') {
        const select = document.createElement('select');
        for (const option of field.options ?? []) {
          const element = document.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          select.appendChild(element);
        }
        select.value = field.value ?? '';
        input = select;
      } else {
        const text = document.createElement('input');
        text.type = field.type ?? 'text';
        text.value = field.value ?? '';
        if (field.placeholder) text.placeholder = field.placeholder;
        input = text;
      }
      inputs.set(field.name, input);
      wrapper.appendChild(input);
      dialog.appendChild(wrapper);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = `
      <button type="button" class="cancel">Отмена</button>
      <div class="spacer"></div>
      <button type="submit" class="primary"></button>
    `;
    actions.querySelector<HTMLButtonElement>('button.primary')!.textContent = options.submitLabel ?? 'Сохранить';
    dialog.appendChild(actions);

    const close = (result: Record<string, string> | null): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown);
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(null);
    };

    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      const result: Record<string, string> = {};
      for (const [name, input] of inputs) result[name] = input.value;
      close(result);
    });
    actions.querySelector<HTMLButtonElement>('button.cancel')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener('keydown', onKeyDown);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const first = [...inputs.values()][0];
    first?.focus();
  });
}

export function confirmDialog(message: string): boolean {
  return window.confirm(message);
}

export interface ConfirmOptions {
  title: string;
  message: string;
  submitLabel?: string;
  /** подпись, которую надо ввести для подтверждения (для совсем разрушительных действий) */
  requirePhrase?: string;
}

/**
 * Модальное подтверждение в стиле приложения. Для массовых операций
 * («очистить все регионы») системного confirm мало: нужно показать, что именно
 * и в каком количестве будет стёрто.
 */
export function confirmModal(options: ConfirmOptions): Promise<boolean> {
  injectStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dlg-backdrop';

    const dialog = document.createElement('form');
    dialog.className = 'dlg';

    const title = document.createElement('h2');
    title.textContent = options.title;
    dialog.appendChild(title);

    const message = document.createElement('div');
    message.className = 'small';
    message.style.whiteSpace = 'pre-line';
    message.textContent = options.message;
    dialog.appendChild(message);

    let phraseInput: HTMLInputElement | null = null;
    if (options.requirePhrase) {
      const field = document.createElement('label');
      field.className = 'field';
      const caption = document.createElement('span');
      caption.textContent = `Введите «${options.requirePhrase}» для подтверждения`;
      phraseInput = document.createElement('input');
      phraseInput.type = 'text';
      field.append(caption, phraseInput);
      dialog.appendChild(field);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Отмена';
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'danger';
    submit.textContent = options.submitLabel ?? 'Очистить';
    actions.append(cancel, spacer, submit);
    dialog.appendChild(actions);

    const close = (result: boolean): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown);
      resolve(result);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(false);
    };

    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      if (options.requirePhrase && phraseInput?.value.trim() !== options.requirePhrase) {
        phraseInput?.focus();
        return;
      }
      close(true);
    });
    cancel.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener('keydown', onKeyDown);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    (phraseInput ?? cancel).focus();
  });
}
