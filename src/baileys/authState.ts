import {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  initAuthCreds,
  proto,
  BufferJSON,
} from "@whiskeysockets/baileys";
import { redis } from "../redis";

// Guarda as credenciais/keys de uma sessão no Redis, chaveadas por
// sessionId. Isso é o que permite a sessão sobreviver a um redeploy do
// container no EasyPanel sem precisar reler o QR toda vez.
export async function useRedisAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const key = (file: string) => `wa:${sessionId}:${file}`;

  const writeData = async (data: unknown, file: string) => {
    try {
      await redis.set(key(file), JSON.stringify(data, BufferJSON.replacer));
    } catch (err) {
      console.error(`[authState] writeData falhou (${file})`, err);
    }
  };

  const readData = async <T>(file: string): Promise<T | null> => {
    try {
      const raw = await redis.get(key(file));
      if (!raw) return null;
      return JSON.parse(raw, BufferJSON.reviver) as T;
    } catch {
      return null;
    }
  };

  const removeData = async (file: string) => {
    try {
      await redis.del(key(file));
    } catch {
      /* best effort */
    }
  };

  const creds: AuthenticationCreds =
    (await readData<AuthenticationCreds>("creds")) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData<any>(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in (data as any)[category]) {
              const value = (data as any)[category][id];
              const file = `${category}-${id}`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds"),
  };
}

// Apaga só a sessão Signal (session-{jid}*) de UM contato específico dentro
// de uma sessão do WhatsApp — não mexe em credenciais nem em outros
// contatos. Isso é a "auto-cura de verdade": em vez de só buscar chave nova
// por cima de uma sessão corrompida (que às vezes ainda falha de novo),
// apaga a corrompida primeiro e deixa o Baileys criar uma limpa do zero.
export async function purgeJidSession(sessionId: string, jid: string): Promise<number> {
  // O jid pode vir como "554598261206@s.whatsapp.net" ou "123@lid" — a
  // chave no Redis usa só a parte numérica antes do @ (ex: "session-554598261206.0").
  const numericId = jid.split("@")[0];
  const pattern = `wa:${sessionId}:session-${numericId}*`;
  const stream = redis.scanStream({ match: pattern });
  const pipeline = redis.pipeline();
  let count = 0;
  for await (const keys of stream) {
    for (const k of keys as string[]) {
      pipeline.del(k);
      count++;
    }
  }
  if (count > 0) await pipeline.exec();
  return count;
}

// Apaga toda a sessão do Redis — usado em logout real ou ao remover a conexão.
export async function clearRedisAuthState(sessionId: string): Promise<void> {
  const stream = redis.scanStream({ match: `wa:${sessionId}:*` });
  const pipeline = redis.pipeline();
  let count = 0;
  for await (const keys of stream) {
    for (const k of keys as string[]) {
      pipeline.del(k);
      count++;
    }
  }
  if (count > 0) await pipeline.exec();
}
