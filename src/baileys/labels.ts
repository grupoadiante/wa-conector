import { getLiveSocket, isSessionHealthy, restartSession } from "./session";
import { config } from "../config";

export interface LabelOpResult {
  ok: boolean;
  error?: string;
  sessionRestarted?: boolean;
}

// Uma operação de etiqueta por vez POR NÚMERO, com uma pausa curta entre
// elas. O WhatsApp trata cada etiqueta como uma alteração de estado da conta;
// várias ao mesmo tempo no mesmo número é o que costumava derrubar a sessão.
const chains = new Map<string, Promise<unknown>>();
const lastOpAt = new Map<string, number>();

function enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = config.labelPaceMs - (Date.now() - (lastOpAt.get(sessionId) ?? 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await job();
    } finally {
      lastOpAt.set(sessionId, Date.now());
    }
  };
  const previous = chains.get(sessionId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  chains.set(sessionId, settled);
  settled.then(() => {
    if (chains.get(sessionId) === settled) chains.delete(sessionId);
  });
  return next;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("label_timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Executa a operação com limite de tempo e confere a saúde da sessão em
// seguida. Se a sessão caiu por causa da operação, ela é reiniciada aqui
// mesmo, sem depender de ninguém notar.
async function withLabelSafety(sessionId: string, op: () => Promise<void>): Promise<LabelOpResult> {
  return enqueue(sessionId, async () => {
    const sock = getLiveSocket(sessionId);
    if (!sock || !sock.ws.isOpen) return { ok: false, error: "session_not_connected" };

    try {
      await withTimeout(op(), config.labelOpTimeoutMs);
    } catch (err) {
      const message = (err as Error)?.message || "label_op_failed";
      console.warn(`[labels:${sessionId}] operação de etiqueta falhou: ${message}`);
      return { ok: false, error: message };
    }

    await new Promise((r) => setTimeout(r, 400));
    if (!(await isSessionHealthy(sessionId))) {
      console.warn(`[labels:${sessionId}] sessão caiu após operação de etiqueta — reiniciando`);
      restartSession(sessionId).catch((e) =>
        console.error(`[labels:${sessionId}] falha ao reiniciar`, (e as Error).message)
      );
      return { ok: true, sessionRestarted: true };
    }
    return { ok: true };
  });
}

// Código HTTP para cada resultado. Tudo que é passageiro fica em 5xx (o CRM
// tenta de novo); o corpo sempre diz o motivo.
export function httpStatusFor(result: LabelOpResult): number {
  if (result.ok) return 200;
  if (result.error === "session_not_connected") return 503;
  if (result.error === "label_timeout") return 504;
  return 502;
}

export async function applyLabel(sessionId: string, chatId: string, labelId: string): Promise<LabelOpResult> {
  return withLabelSafety(sessionId, async () => {
    const sock = getLiveSocket(sessionId)!;
    await sock.chatModify({ addChatLabel: { labelId } }, chatId);
  });
}

export async function removeLabel(sessionId: string, chatId: string, labelId: string): Promise<LabelOpResult> {
  return withLabelSafety(sessionId, async () => {
    const sock = getLiveSocket(sessionId)!;
    await sock.chatModify({ removeChatLabel: { labelId } }, chatId);
  });
}

// Cria ou edita a DEFINIÇÃO de uma etiqueta (nome/cor). O `id` é escolhido
// por quem chama; reaproveitar o mesmo id edita a etiqueta existente.
export async function upsertLabelDefinition(
  sessionId: string,
  label: { id: string; name?: string; color?: number; deleted?: boolean }
): Promise<LabelOpResult> {
  return withLabelSafety(sessionId, async () => {
    const sock = getLiveSocket(sessionId)!;
    await sock.chatModify({ addLabel: label }, sock.user!.id);
  });
}
