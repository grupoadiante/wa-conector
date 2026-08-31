import NodeCache from "node-cache";
import { proto, WAMessage, WAMessageKey } from "@whiskeysockets/baileys";

// msgRetryCounterCache: o Baileys usa isso pra controlar quantas vezes já
// tentou re-sincronizar a chave de uma mensagem que falhou ao decriptar
// (o erro "SessionError: No session record" que vimos nos logs). Sem esse
// cache configurado, esse controle fica mais frágil — é o que a própria
// documentação do Baileys aponta como causa do "Waiting for this message".
export const msgRetryCounterCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// getMessage: quando alguém pede reenvio de uma mensagem (retry receipt), o
// Baileys precisa conseguir devolver o conteúdo original pra reenviar
// (sendMessagesAgain, que já renegocia a sessão automaticamente via
// assertSessions por baixo dos panos). Se o pedido de retry chegar depois
// que o cache expirou, o Baileys desiste silenciosamente ("message not
// available") — foi exatamente isso que aconteceu com o "Aguardando
// mensagem" no Desktop, que demorou mais que os 5 minutos antigos. 24h é
// bem mais realista pro tempo que um dispositivo pode ficar sem processar
// um retry (guarda só o conteúdo da mensagem, não o objeto inteiro).
const messageCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600, useClones: false });

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
