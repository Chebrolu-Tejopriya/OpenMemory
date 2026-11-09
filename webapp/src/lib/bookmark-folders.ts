export function bookmarkFolderLabel(path: string): string {
  return path.split('/').at(-1) === 'Recovered from Open Memory - 2026-11-07' ? 'OM' : path;
}

export function bookmarkFolderName(path: string): string {
  const label = bookmarkFolderLabel(path);
  return label.split('/').at(-1) || label;
}
