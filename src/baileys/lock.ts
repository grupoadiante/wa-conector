import { randomUUID } from "node:crypto";
import { redis } from "../redis";

// Durante um redeploy, o EasyPanel pode manter o container antigo de pé por
// alguns segundos enquanto o novo sobe (zero-downtime). Se os dois tentarem
// segurar a MESMA sessão do WhatsApp ao mesmo tempo, o WhatsApp começa a
// alternar entre eles ("stream:error conflict replaced" em loop), o que
// corrompe as chaves de criptografia por contato. Esse lock garante que só
// um processo por vez fica "dono" de cada sessão.
const LOCK_TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;

const lockKey = (id: string) => `wa:lock:${id}`;
const owned = new Map<string, { value: string; heartbeat: NodeJS.Timeout }>();

export async function acquireLock(id: string): Promise<boolean> {
  // Reconexão automática (queda recuperável) chama startSession de novo no
  // mesmo processo, que já é dono do lock — não tenta adquirir de novo.
  if (owned.has(id)) return true;

  const value = randomUUID();
  const ok = await redis.set(lockKey(id), value, "PX", LOCK_TTL_MS, "NX");
  if (ok !== "OK") return false;

  const heartbeat = setInterval(() => {
    redis.set(lockKey(id), value, "PX", LOCK_TTL_MS, "XX").catch((err) =>
      console.error(`[lock] falha ao renovar lock de ${id}`, err)
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  owned.set(id, { value, heartbeat });
  return true;
}

export async function releaseLock(id: string): Promise<void> {
  const entry = owned.get(id);
  if (!entry) return;
  clearInterval(entry.heartbeat);
  owned.delete(id);
  try {
    const current = await redis.get(lockKey(id));
    if (current === entry.value) await redis.del(lockKey(id));
  } catch (err) {
    console.error(`[lock] falha ao liberar lock de ${id}`, err);
  }
}
