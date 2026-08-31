import { getLiveSocket, isSessionHealthy, restartSession } from "./session";
import { sendWebhookEvent } from "../webhook";

interface LabelOpResult {
  ok: boolean;
  error?: string;
  sessionRestarted?: boolean;
}

// Esse é o ponto exato do bug que motivou esse conector: aplicar/remover
// etiqueta pode derrubar a sessão baixo nível alguns instantes depois.
// Isolamos a chamada, e OBRIGATORIAMENTE conferimos a saúde da sessão
// logo em seguida — se caiu, reconectamos sozinhos em vez de deixar a
// lista de etiquetas sumir silenciosamente pro usuário.
async function withLabelSafety(
  sessionId: string,
  op: () => Promise<void>
): Promise<LabelOpResult> {
  const sock = getLiveSocket(sessionId);
  if (!sock) return { ok: false, error: "session_not_connected" };

  try {
    await op();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Pequena espera — o crash observado no WAHA acontece ~1min depois, mas
  // uma checagem imediata já pega quedas rápidas; o watchdog do lado do
  // Supabase (custom-health-check) cobre o resto da janela.
  await new Promise((r) => setTimeout(r, 1500));
  const healthy = await isSessionHealthy(sessionId);
  if (!healthy) {
    console.warn(`[labels] sessão ${sessionId} caiu após operação de label — reconectando`);
    await sendWebhookEvent(sessionId, "session.status", {
      status: "failed",
      reason: "label_op_crash",
    });
    restartSession(sessionId).catch((e) =>
      console.error(`[labels] falha ao reconectar ${sessionId}`, e)
    );
    return { ok: true, sessionRestarted: true };
  }

  return { ok: true };
}

export async function applyLabel(
  sessionId: string,
  chatId: string,
  labelId: string
): Promise<LabelOpResult> {
  return withLabelSafety(sessionId, async () => {
    const sock = getLiveSocket(sessionId)!;
    await sock.chatModify({ addChatLabel: { labelId } }, chatId);
  });
}

export async function removeLabel(
  sessionId: string,
  chatId: string,
  labelId: string
): Promise<LabelOpResult> {
  return withLabelSafety(sessionId, async () => {
    const sock = getLiveSocket(sessionId)!;
    await sock.chatModify({ removeChatLabel: { labelId } }, chatId);
  });
}

// Cria ou edita a DEFINIÇÃO de uma etiqueta (nome/cor) — diferente de
// aplicá-la numa conversa. O `id` é escolhido por quem chama (WhatsApp não
// gera um automaticamente); reaproveitar o mesmo id em chamadas futuras edita
// a etiqueta existente em vez de criar uma nova.
export async function upsertLabelDefinition(
  sessionId: string,
  label: { id: string; name?: string; color?: number; deleted?: boolean }
): Promise<LabelOpResult> {
  return withLabelSafety(sessionId, async () => {
    const sock = getLiveSocket(sessionId)!;
    // O jid aqui é só o contexto da chamada — a definição da etiqueta é
    // global na conta, não por conversa.
    await sock.chatModify({ addLabel: label }, sock.user!.id);
  });
}
