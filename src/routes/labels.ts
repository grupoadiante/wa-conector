import { Router } from "express";
import { getLiveSocket } from "../baileys/session";
import { applyLabel, removeLabel, upsertLabelDefinition } from "../baileys/labels";
import { listLabelsFromStore } from "../baileys/labelStore";
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
    res.status(502).json({ error: (err as Error).message });
  }
});

// Cria uma etiqueta nova, ou edita uma existente se você reenviar o mesmo id.
// O WhatsApp não gera o id sozinho — normalmente usa-se um UUID ou um
// contador próprio; guarde o id retornado pra reaproveitar depois.
labelsRouter.post("/sessions/:id/labels", async (req, res) => {
  const { id } = req.params;
  const { label_id, name, color, deleted } = req.body as {
    label_id?: string;
    name?: string;
    color?: number;
    deleted?: boolean;
  };
  if (!label_id) return res.status(400).json({ error: "label_id is required" });

  const sock = getLiveSocket(id);
  if (!sock) return res.status(409).json({ error: "session_not_connected" });

  const result = await upsertLabelDefinition(id, { id: label_id, name, color, deleted });
  res.status(result.ok ? 200 : 502).json(result);
});

labelsRouter.post("/sessions/:id/labels/apply", async (req, res) => {
  const { id } = req.params;
  const { chat_id, label_id } = req.body as { chat_id?: string; label_id?: string };
  if (!chat_id || !label_id) {
    return res.status(400).json({ error: "chat_id and label_id are required" });
  }
  const result = await applyLabel(id, toJid(chat_id), label_id);
  res.status(result.ok ? 200 : 502).json(result);
});

labelsRouter.post("/sessions/:id/labels/remove", async (req, res) => {
  const { id } = req.params;
  const { chat_id, label_id } = req.body as { chat_id?: string; label_id?: string };
  if (!chat_id || !label_id) {
    return res.status(400).json({ error: "chat_id and label_id are required" });
  }
  const result = await removeLabel(id, toJid(chat_id), label_id);
  res.status(result.ok ? 200 : 502).json(result);
});
