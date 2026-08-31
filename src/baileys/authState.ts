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
