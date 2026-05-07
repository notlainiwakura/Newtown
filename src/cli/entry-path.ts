export function isCliEntryPath(pathname: string | undefined): boolean {
  const normalized = pathname?.replace(/\\/g, '/');
  return Boolean(
    normalized?.endsWith('lain.js') ||
    normalized?.endsWith('newtown.js') ||
    normalized?.endsWith('lain') ||
    normalized?.endsWith('newtown') ||
    normalized?.includes('dist/index.js') ||
    normalized?.includes('src/index.ts')
  );
}
