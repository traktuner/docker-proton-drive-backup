// Runs once when the Next.js server process boots.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Log instead of crashing on a stray rejection. Node 15+ terminates the process
    // on an unhandled rejection by default; a single fire-and-forget slip (e.g. a
    // background backup task) should not take the whole server down.
    process.on('unhandledRejection', (reason) => {
      console.error('[unhandledRejection]', reason);
    });

    // Declarative deploy: import backup sets from CONFIG_DIR if present.
    const { autoImportFromConfigDir } = await import('./server/config');
    autoImportFromConfigDir();

    const { startScheduler } = await import('./server/scheduler');
    startScheduler();
  }
}
