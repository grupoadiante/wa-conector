import { getLiveSocket, isSessionHealthy, restartSession, resyncLabels, requestLabelStateRecovery } from "./session";
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
// Linhas em que o WhatsApp recusa entregar o estado das etiquetas (erro 403
// ao baixar o arquivo de sincronização). Enquanto isso durar, NENHUMA
// etiqueta é gravada nessa linha. Guardamos para avisar no /sessions-health
// e para não martelar a releitura a cada venda.
interface LabelBlock {
  since: number;
  failures: number;
  lastRecoveryAt: number;
}
const blocked = new Map<string, LabelBlock>();
const RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;
export const LABELS_BLOCKED_ERROR =
  "labels_blocked_repair_needed: o WhatsApp recusou (403) o estado de etiquetas desta linha. O conector pediu ao celular um estado novo; se continuar, desconecte TODOS os dispositivos no aparelho e pareie de novo.";

export function getLabelBlock(sessionId: string): LabelBlock | null {
  return blocked.get(sessionId) ?? null;
}
export function clearLabelBlock(sessionId: string): void {
  blocked.delete(sessionId);
}
export function listLabelBlocks(): string[] {
  return [...blocked.keys()];
}

function isAppState403(message: string): boolean {
  return /status code 403/i.test(message);
}

async function withLabelSafety(sessionId: string, op: () => Promise<void>): Promise<LabelOpResult> {
  return enqueue(sessionId, async () => {
    const sock = getLiveSocket(sessionId);
    if (!sock || !sock.ws.isOpen) return { ok: false, error: "session_not_connected" };

    try {
      await withTimeout(op(), config.labelOpTimeoutMs);
    } catch (err) {
      let message = (err as Error)?.message || "label_op_failed";

      if (isAppState403(message)) {
        const block = blocked.get(sessionId) ?? { since: Date.now(), failures: 0, lastRecoveryAt: 0 };
        block.failures += 1;
        blocked.set(sessionId, block);

        // Auto-recuperação: relê o estado do zero e tenta a operação mais uma
        // vez. No máximo uma tentativa a cada 30 min por linha.
        if (Date.now() - block.lastRecoveryAt > RECOVERY_COOLDOWN_MS) {
          block.lastRecoveryAt = Date.now();
          console.warn(`[labels:${sessionId}] estado de etiquetas recusado (403) — relendo do zero e tentando de novo`);
          try {
            await withTimeout(resyncLabels(sessionId), 30_000);
            await withTimeout(op(), config.labelOpTimeoutMs);
            blocked.delete(sessionId);
            console.log(`[labels:${sessionId}] recuperado após releitura`);
            return { ok: true };
          } catch (retryErr) {
            console.warn(
              `[labels:${sessionId}] releitura não resolveu (${(retryErr as Error)?.message}) — pedindo ao celular um estado novo`
            );
            requestLabelStateRecovery(sessionId).catch((e) =>
              console.warn(`[labels:${sessionId}] pedido de recuperação falhou: ${(e as Error).message}`)
            );
          }
        }
        message = LABELS_BLOCKED_ERROR;
      } else {
        console.warn(`[labels:${sessionId}] operação de etiqueta falhou: ${message}`);
      }
      return { ok: false, error: message };
    }

    blocked.delete(sessionId);
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

// Código HTTP para cada resultado. NÃO usamos 502/503/504: o proxy do
// EasyPanel troca essas respostas por uma página HTML dele e o motivo real
// some. Com 4xx o corpo JSON chega inteiro a quem chamou.
export function httpStatusFor(result: LabelOpResult): number {
  if (result.ok) return 200;
  return httpStatusForError(result.error ?? "");
}
export function httpStatusForError(error: string): number {
  if (error === "session_not_connected") return 409;
  if (error === "label_timeout") return 408;
  if (error.startsWith("labels_blocked_repair_needed")) return 423;
  return 422;
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
