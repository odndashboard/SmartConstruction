/** The Android shell exposes this object only to the trusted main CRM origin. */
interface NativeMessenger { postMessage(message: string): void; }

function nativeMessenger(): NativeMessenger | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as Window & { SmartConstructionNative?: NativeMessenger }).SmartConstructionNative;
  return typeof bridge?.postMessage === 'function' ? bridge : undefined;
}

/** Keep desktop downloads and Android's system Save dialog on one code path. */
export function saveTextFile(filename: string, text: string, mime: string): void {
  const native = nativeMessenger();
  if (native) {
    native.postMessage(JSON.stringify({ type: 'save-text', filename, text, mime }));
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let the browser acquire the Blob before releasing its object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Android's print framework provides both printers and Save as PDF. */
export function printDocument(): void {
  const native = nativeMessenger();
  if (native) native.postMessage(JSON.stringify({ type: 'print' }));
  else window.print();
}
