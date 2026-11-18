// Proteção de CPU direto no libsignal.
//
// Problema visto ao vivo: um contato cujo contador de mensagem "pula" mais de
// 2000 de uma vez faz o libsignal tentar derivar até 2000 chaves (HMAC) ANTES
// de desistir com "Over 2000 messages into the future". E isso se repete para
// CADA sessão antiga guardada daquele contato (até ~40) em CADA mensagem, e
// ainda escreve um console.error com stack para cada uma. Resultado: CPU em
// 100%+ e o container acaba caindo. Renegociar ou bloquear no WhatsApp não
// elimina esse custo de forma confiável, então aqui a gente corta na fonte:
//
//  1. Na primeira vez que um contato estoura o limite, ele entra em
//     "quarentena" por QUARANTINE_MS: qualquer tentativa de decifrar mensagem
//     dele falha NA HORA (barato, sem derivar chave, sem log com stack).
//  2. Mesmo para contatos normais, limita quantas sessões antigas são
//     tentadas por mensagem (MAX_SESSIONS_TRIED), que é o multiplicador.
//
// Mensagens de contato em quarentena são perdidas (já eram indecifráveis).
// Depois do prazo, uma nova tentativa acontece e, se falhar igual, ele volta
// pra quarentena.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const libsignal = require("libsignal");

const QUARANTINE_MS = 30 * 60 * 1000;
const MAX_SESSIONS_TRIED = 6;

const quarantinedUntil = new Map<string, number>();
let installed = false;

// IDs que NUNCA entram em quarentena: os da própria conta de cada sessão.
//
// Visto em 18/11: quando a comunicação entre o conector e o celular da
// própria conta perde a sincronia, o celular tenta refazê-la mandando uma
// mensagem com chave nova. Com a própria conta em quarentena, essa tentativa
// era rejeitada por 30 minutos — e de novo, e de novo. A linha nunca se
// recuperava e parava de receber as chaves de sincronização das etiquetas.
// A quarentena existe para um LEAD que quebra o protocolo, não para a conta.
const exemptIds = new Set<string>();

export function exemptFromQuarantine(jid: string | undefined | null): void {
  if (!jid) return;
  const id = jid.split("@")[0].split(":")[0];
  if (!id) return;
  exemptIds.add(id);
  quarantinedUntil.delete(id);
}

function isQuarantined(id: string): boolean {
  if (exemptIds.has(id)) return false;
  const until = quarantinedUntil.get(id);
  if (!until) return false;
  if (Date.now() < until) return true;
  quarantinedUntil.delete(id);
  return false;
}

export function getQuarantinedContacts(): string[] {
  const now = Date.now();
  return [...quarantinedUntil.entries()].filter(([, t]) => t > now).map(([id]) => id);
}

export function installLibsignalGuard(): void {
  if (installed) return;
  installed = true;

  const proto = libsignal.SessionCipher.prototype;
  const SessionError = libsignal.SessionError;

  const origDecryptWithSessions = proto.decryptWithSessions;
  proto.decryptWithSessions = function (this: any, data: Buffer, sessions: any[]) {
    const id = this.addr?.id as string | undefined;
    if (id && isQuarantined(id)) {
      return Promise.reject(new SessionError("contact quarantined (Over 2000 messages into the future)"));
    }
    const limited = Array.isArray(sessions) && sessions.length > MAX_SESSIONS_TRIED
      ? sessions.slice(0, MAX_SESSIONS_TRIED)
      : sessions;
    return origDecryptWithSessions.call(this, data, limited);
  };

  const origDoDecrypt = proto.doDecryptWhisperMessage;
  proto.doDecryptWhisperMessage = async function (this: any, ...args: any[]) {
    const id = this.addr?.id as string | undefined;
    if (id && isQuarantined(id)) {
      throw new SessionError("contact quarantined (Over 2000 messages into the future)");
    }
    try {
      return await origDoDecrypt.apply(this, args);
    } catch (e: any) {
      if (
        id &&
        !exemptIds.has(id) &&
        typeof e?.message === "string" &&
        e.message.includes("Over 2000 messages into the future")
      ) {
        if (!quarantinedUntil.has(id)) {
          console.warn(
            `[libsignal-guard] contato ${id} estourou "Over 2000 messages into the future" — quarentena de ${QUARANTINE_MS / 60000}min (mensagens dele serão descartadas sem custo de CPU)`
          );
        }
        quarantinedUntil.set(id, Date.now() + QUARANTINE_MS);
      }
      throw e;
    }
  };
}
