// O libsignal (usado por baixo do Baileys) escreve alguns erros DIRETO no
// console.error, sem passar pelo logger que a gente passa pro makeWASocket
// (ver node_modules/libsignal/src/session_cipher.js linhas 157/159). Por
// isso o decrypt-watch normal (que só escuta o logger) nunca via esse caso.
//
// Só reiniciar a sessão inteira não resolve — a corrupção é por CONTATO,
// não da sessão toda, e o WhatsApp reconecta com o mesmo estado corrompido
// na hora. A correção de verdade é a mesma que já funciona pro caso normal:
// assertSessions(jid, force=true) só com aquele contato.
//
// A pista: o stack trace do erro cru inclui o número like
// "at async 554598261206.0 [as awaitable]" — dá pra extrair o contato de
// lá e alimentar o mesmo failureTracker por-jid que o decrypt-watch usa.

const JID_IN_STACK = /at async (\d+)\.\d+ \[as awaitable\]/;

export interface RawSignalErrorSink {
  noteRawFailure(numericId: string): void;
}

let installed = false;
const sinks = new Set<RawSignalErrorSink>();

export function registerRawSignalErrorSink(sink: RawSignalErrorSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

// "Disjuntor" por contato: como o erro cru não diz de qual sessão veio,
// a gente manda pra TODAS (ver loop abaixo) — isso é correto pro caso comum
// (um contato corrompido numa sessão só), mas vira um problema quando o
// contato em si é incompatível com o protocolo Signal de um jeito que
// renegociar nunca resolve (visto ao vivo em 06/10: número que manda em
// disparo e cujo contador de mensagem pula mais de 2000 de uma vez —
// "Over 2000 messages into the future" — e também aparece como Bad MAC).
// Cada mensagem nova desse contato gera um erro cru, que dispara
// renegociação em TODAS as ~30 sessões simultaneamente, toda vez — um
// contato só vira um multiplicador de carga em todo o servidor. Se isso
// acontecer muitas vezes seguidas, a gente desiste temporariamente desse
// contato específico (só ele, as outras sessões/contatos continuam normais)
// em vez de ficar brigando com um problema que renegociação não resolve.
const GIVE_UP_THRESHOLD = 15;
const GIVE_UP_WINDOW_MS = 2 * 60 * 1000;
const GIVE_UP_COOLDOWN_MS = 20 * 60 * 1000;

const dispatchHits = new Map<string, number[]>();
const givenUpUntil = new Map<string, number>();

export function installRawSignalErrorWatch(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);

    const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    const match = text.match(JID_IN_STACK);
    if (!match) return;

    const numericId = match[1];
    const now = Date.now();

    const giveUpExpiry = givenUpUntil.get(numericId);
    if (giveUpExpiry) {
      if (now < giveUpExpiry) return; // em cool-off, ignora completamente
      givenUpUntil.delete(numericId);
    }

    const hits = (dispatchHits.get(numericId) ?? []).filter((t) => now - t <= GIVE_UP_WINDOW_MS);
    hits.push(now);
    if (hits.length > GIVE_UP_THRESHOLD) {
      givenUpUntil.set(numericId, now + GIVE_UP_COOLDOWN_MS);
      dispatchHits.delete(numericId);
      console.warn(
        `[raw-signal-watch] contato ${numericId} gerou mais de ${GIVE_UP_THRESHOLD} erros crus em ${GIVE_UP_WINDOW_MS / 1000}s mesmo com renegociação — parece um número incompatível com o protocolo (ex: disparo em massa). Pausando auto-cura desse contato por ${GIVE_UP_COOLDOWN_MS / 60000}min pra não sobrecarregar o servidor; as outras sessões continuam normais.`
      );
      return;
    }
    dispatchHits.set(numericId, hits);

    // Não sabe de qual sessão é (o console.error é global, várias sessões
    // podem rodar no mesmo processo) — manda pra todas; a que não tiver
    // esse contato simplesmente não encontra nada pra renegociar.
    for (const sink of sinks) {
      sink.noteRawFailure(numericId);
    }
  };
}
