// Runs once when the Next.js server process boots.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Declarative deploy: import backup sets from CONFIG_DIR if present.
    const { autoImportFromConfigDir } = await import('./server/config');
    autoImportFromConfigDir();

    const { startScheduler } = await import('./server/scheduler');
    startScheduler();
  }
}
