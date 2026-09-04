/** Файловый ввод-вывод без сервера: <input type=file>, Blob-скачивание, File System Access API. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // отпускаем URL позже — Safari может ещё не начать скачивание
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      resolve(input.files ? Array.from(input.files) : []);
      input.remove();
    });
    // отмена диалога не даёт события change — чистим по фокусу окна
    window.addEventListener(
      'focus',
      () => setTimeout(() => {
        if (document.body.contains(input) && (!input.files || input.files.length === 0)) {
          resolve([]);
          input.remove();
        }
      }, 400),
      { once: true },
    );
    input.click();
  });
}

/* ---- File System Access API (Chromium): работа с файлом на диске без «скачать заново» ---- */

interface FsFileHandle {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}

interface FsWindow extends Window {
  showSaveFilePicker?: (options: unknown) => Promise<FsFileHandle>;
  showOpenFilePicker?: (options: unknown) => Promise<FsFileHandle[]>;
}

export function hasFileSystemAccess(): boolean {
  const fsWindow = window as FsWindow;
  return typeof fsWindow.showSaveFilePicker === 'function';
}

let currentHandle: FsFileHandle | null = null;

export function currentFileName(): string | null {
  return currentHandle?.name ?? null;
}

export function forgetFileHandle(): void {
  currentHandle = null;
}

/** Сохранить в ранее выбранный файл; если его нет — спросить куда. Возвращает false, если API нет. */
export async function saveToDisk(blob: Blob, suggestedName: string, forcePicker = false): Promise<boolean> {
  const fsWindow = window as FsWindow;
  if (!fsWindow.showSaveFilePicker) return false;
  if (forcePicker || !currentHandle) {
    currentHandle = await fsWindow.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Worldbuilder Atlas world', accept: { 'application/zip': ['.zip'] } }],
    });
  }
  const writable = await currentHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

export async function openFromDisk(): Promise<File | null> {
  const fsWindow = window as FsWindow;
  if (!fsWindow.showOpenFilePicker) return null;
  const [handle] = await fsWindow.showOpenFilePicker({
    types: [{ description: 'Worldbuilder Atlas world', accept: { 'application/zip': ['.zip'] } }],
    multiple: false,
  });
  if (!handle) return null;
  currentHandle = handle;
  return handle.getFile();
}
