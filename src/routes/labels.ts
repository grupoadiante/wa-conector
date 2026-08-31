import { Router } from "express";
import { getLiveSocket } from "../baileys/session";
import { applyLabel, removeLabel } from "../baileys/labels";
import { toJid } from "../jid";

export const labelsRouter = Router();

labelsRouter.get("/sessions/:id/labels", async (req, res) => {
  const { id } = req.params;
  const sock = getLiveSocket(id);
  if (!sock) return res.status(409).json({ error: "session_not_connected" });

  try {
    // Labels ficam no store de app-state do Baileys.
    const labels = (sock as any).labels ?? [];
    res.json({ labels });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
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
