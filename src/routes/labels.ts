import { Router } from "express";
import { resyncLabels, requestLabelStateRecovery } from "../baileys/session";
import { applyLabel, removeLabel, upsertLabelDefinition, httpStatusFor, httpStatusForError, clearLabelBlock } from "../baileys/labels";
import { listLabelsFromStore, listChatLabels } from "../baileys/labelStore";
import { toJid } from "../jid";

export const labelsRouter = Router();

// Etiquetas definidas na conta (nome/cor), a partir do cache alimentado pelo
// evento labels.edit — não existe um "get all" direto no Baileys.
labelsRouter.get("/sessions/:id/labels", async (req, res) => {
  const { id } = req.params;
  try {
    const labels = await listLabelsFromStore(id);
    res.json({ labels });
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

// Relê as etiquetas direto do WhatsApp (use quando a lista vier vazia mesmo
// com etiquetas criadas no aparelho). A auto-cura também faz isso sozinha.
labelsRouter.post("/sessions/:id/labels/resync", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await Promise.race([
      resyncLabels(id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("label_timeout")), 45_000)),
    ]);
    clearLabelBlock(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = (err as Error).message || "resync_failed";
    console.warn(`[labels:${id}] releitura manual falhou: ${message}`);
    const blocked = /status code 403/i.test(message);
    res.status(httpStatusForError(message)).json({
      ok: false,
      error: message,
      ...(blocked
        ? {
            hint: "O arquivo de estado desta conta venceu no WhatsApp. Parear de novo só a linha de etiquetas não resolve: no celular, saia de TODOS os dispositivos conectados e pareie de novo a conexão principal e a linha de etiquetas.",
          }
        : {}),
    });
  }
});

// Recuperação MANUAL para linha bloqueada por 403. Exige {"confirm":"desvincular"}
// no corpo, porque o celular desvincula esta linha ao receber o aviso. Depois:
// recriar a linha de etiquetas no CRM e ler o QR de novo.
labelsRouter.post("/sessions/:id/labels/recover", async (req, res) => {
  const { id } = req.params;
  if ((req.body as { confirm?: string })?.confirm !== "desvincular") {
    return res.status(400).json({
      ok: false,
      error: "confirm_required",
      hint: 'Este comando faz o celular desvincular esta linha de etiquetas. Envie {"confirm":"desvincular"} para prosseguir.',
    });
  }
  try {
    await requestLabelStateRecovery(id);
    res.json({
      ok: true,
      requested: true,
      next: "A linha deve cair em até 1 minuto. Recrie a linha de etiquetas no CRM, leia o QR e confira etiquetas > 0 no /sessions-health.",
    });
  } catch (err) {
    const message = (err as Error).message || "recover_failed";
    res.status(httpStatusForError(message)).json({ ok: false, error: message });
  }
});

// Cria uma etiqueta nova, ou edita uma existente se você reenviar o mesmo id.
labelsRouter.post("/sessions/:id/labels", async (req, res) => {
  const { id } = req.params;
  const { label_id, name, color, deleted } = req.body as {
    label_id?: string;
    name?: string;
    color?: number;
    deleted?: boolean;
  };
  if (!label_id) return res.status(400).json({ error: "label_id is required" });

  const result = await upsertLabelDefinition(id, { id: label_id, name, color, deleted });
  res.status(httpStatusFor(result)).json(result);
});

labelsRouter.post("/sessions/:id/labels/apply", async (req, res) => {
  const { id } = req.params;
  const { chat_id, label_id } = req.body as { chat_id?: string; label_id?: string };
  if (!chat_id || !label_id) {
    return res.status(400).json({ error: "chat_id and label_id are required" });
  }
  const result = await applyLabel(id, toJid(chat_id), String(label_id));
  res.status(httpStatusFor(result)).json(result);
});

labelsRouter.post("/sessions/:id/labels/remove", async (req, res) => {
  const { id } = req.params;
  const { chat_id, label_id } = req.body as { chat_id?: string; label_id?: string };
  if (!chat_id || !label_id) {
    return res.status(400).json({ error: "chat_id and label_id are required" });
  }
  const result = await removeLabel(id, toJid(chat_id), String(label_id));
  res.status(httpStatusFor(result)).json(result);
});

// Quais etiquetas um chat específico tem.
labelsRouter.get("/sessions/:id/labels/chats/:chatId", async (req, res) => {
  const { id, chatId } = req.params;
  try {
    const labelIds = await listChatLabels(id, toJid(chatId));
    res.json({ chat_id: toJid(chatId), label_ids: labelIds });
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});
