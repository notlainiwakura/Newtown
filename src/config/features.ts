export function isResearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['ENABLE_RESEARCH'];
  if (raw === undefined) return true;

  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}
