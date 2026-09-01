import { redis } from "../redis";

export interface StoredLabel {
  id: string;
  name: string;
  color: number;
  deleted: boolean;
}

const key = (sessionId: string) => `wa:labels:${sessionId}`;
const assocKey = (sessionId: string, chatId: string) => `wa:label-assoc:${sessionId}:${chatId}`;

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

// Associações etiqueta↔chat — alimentado pelo evento "labels.association"
// do Baileys. Sem isso não tinha como responder "quais etiquetas esse chat
// tem", só aplicar/remover às cegas — o painel do CRM sempre mostrava
// "nenhuma etiqueta aplicada" mesmo quando a aplicação funcionava.
export async function setChatLabelAssociation(
  sessionId: string,
  chatId: string,
  labelId: string,
  applied: boolean
): Promise<void> {
  if (applied) {
    await redis.sadd(assocKey(sessionId, chatId), labelId);
  } else {
    await redis.srem(assocKey(sessionId, chatId), labelId);
  }
}

export async function listChatLabels(sessionId: string, chatId: string): Promise<string[]> {
  return redis.smembers(assocKey(sessionId, chatId));
}
