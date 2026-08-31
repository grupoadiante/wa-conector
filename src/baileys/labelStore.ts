import { redis } from "../redis";

export interface StoredLabel {
  id: string;
  name: string;
  color: number;
  deleted: boolean;
}

const key = (sessionId: string) => `wa:labels:${sessionId}`;

export async function upsertLabelInStore(sessionId: string, label: StoredLabel): Promise<void> {
  if (label.deleted) {
    await redis.hdel(key(sessionId), label.id);
    return;
  }
  await redis.hset(key(sessionId), label.id, JSON.stringify(label));
}

export async function listLabelsFromStore(sessionId: string): Promise<StoredLabel[]> {
  const all = await redis.hgetall(key(sessionId));
  return Object.values(all).map((v) => JSON.parse(v) as StoredLabel);
}
