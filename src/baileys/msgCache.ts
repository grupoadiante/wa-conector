import NodeCache from "node-cache";
import { proto, WAMessage, WAMessageKey } from "@whiskeysockets/baileys";

// msgRetryCounterCache: o Baileys usa isso pra controlar quantas vezes já
// tentou re-sincronizar a chave de uma mensagem que falhou ao decriptar
// (o erro "SessionError: No session record" que vimos nos logs). Sem esse
// cache configurado, esse controle fica mais frágil — é o que a própria
// documentação do Baileys aponta como causa do "Waiting for this message".
export const msgRetryCounterCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// getMessage: quando alguém pede reenvio de uma mensagem (retry receipt), o
// Baileys precisa conseguir devolver o conteúdo original. Sem isso, o pedido
// de retry cai no vazio e o remetente fica preso no "aguardando mensagem".
// Cache simples em memória, por processo — só precisa cobrir mensagens
// recentes (minutos), não histórico completo.
const messageCache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });

function cacheKey(key: WAMessageKey): string {
  return `${key.remoteJid}:${key.id}`;
}

export function rememberMessage(msg: WAMessage): void {
  if (!msg.key?.id) return;
  messageCache.set(cacheKey(msg.key), msg.message);
}

export async function getCachedMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
  return messageCache.get<proto.IMessage>(cacheKey(key));
}
