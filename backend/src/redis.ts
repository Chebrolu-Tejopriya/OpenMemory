import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function getCache<T>(key: string): Promise<T | null> {
  try {
    const val = await redis.get<T>(key);
    return val ?? null;
  } catch {
    return null;
  }
}

export async function setCache<T>(key: string, data: T, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, data, { ex: ttlSeconds });
  } catch {}
}

export async function invalidate(...keys: string[]): Promise<void> {
  try {
    if (keys.length > 0) await redis.del(...keys);
  } catch {}
}
