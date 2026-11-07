import { currentAccount } from './drive';

/** Storage usage of the signed-in account (cached ~60 s by the runtime). */

export interface Quota {
  maxSpace: number;
  usedSpace: number;
  driveUsed: number;
}

export interface UserInfo {
  email: string | null;
  displayName: string | null;
  quota: Quota | null;
  productUsed: Record<string, number>;
}

export async function getUserInfo(): Promise<UserInfo | null> {
  try {
    const a = await currentAccount();
    if (!a) return null;
    return {
      email: a.email,
      displayName: a.displayName,
      productUsed: { Drive: a.driveUsed },
      quota: { maxSpace: a.maxSpace, usedSpace: a.usedSpace, driveUsed: a.driveUsed },
    };
  } catch {
    return null;
  }
}

export async function getQuota(): Promise<Quota | null> {
  return (await getUserInfo())?.quota ?? null;
}
