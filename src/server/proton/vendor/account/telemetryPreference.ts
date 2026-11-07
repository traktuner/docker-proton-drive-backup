import type { AccountApi } from './accountApi';
import type { Logger } from './logger';

export async function fetchTelemetryEnabled(accountApi: AccountApi, logger: Logger): Promise<boolean> {
    try {
        const settings = await accountApi.settings();
        return settings.UserSettings?.Telemetry === 1;
    } catch (error: unknown) {
        logger.error('Failed to fetch telemetry preference', error);
        return false;
    }
}
