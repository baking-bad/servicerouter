// Runs once when the Next.js server starts: the website's startup line (L-1). Node.js only.
export const register = async (): Promise<void> => {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs')
    return;

  const { logStartup } = await import('./src/startup');
  logStartup();
};
