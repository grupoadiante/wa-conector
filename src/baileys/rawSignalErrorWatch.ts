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
    // Não sabe de qual sessão é (o console.error é global, várias sessões
    // podem rodar no mesmo processo) — manda pra todas; a que não tiver
    // esse contato simplesmente não encontra nada pra renegociar.
    for (const sink of sinks) {
      sink.noteRawFailure(numericId);
    }
  };
}
