import { Router } from "express";
import { getLiveSocket } from "../baileys/session";
import { toJid } from "../jid";
import { pdfFirstPageThumbnail } from "../baileys/pdfThumbnail";

export const messagesRouter = Router();

function requireSocket(id: string, res: import("express").Response) {
  const sock = getLiveSocket(id);
  if (!sock) {
    res.status(409).json({ error: "session_not_connected" });
    return null;
  }
  return sock;
}

messagesRouter.post("/sessions/:id/send-text", async (req, res) => {
  const { id } = req.params;
  const { to, text } = req.body as { to?: string; text?: string };
  if (!to || !text) return res.status(400).json({ error: "to and text are required" });

  const sock = requireSocket(id, res);
  if (!sock) {
    console.warn(`[send-text:${id}] rejeitado — sessão não conectada (to=${to})`);
    return;
  }

  const jid = toJid(to);
  console.log(`[send-text:${id}] enviando para ${jid} (${text.length} chars)`);
  try {
    const sent = await sock.sendMessage(jid, { text });
    console.log(`[send-text:${id}] enviado com sucesso — provider_message_id=${sent?.key?.id}`);
    res.json({
      provider_message_id: sent?.key?.id ?? null,
      resolved_jid: jid,
    });
  } catch (err) {
    console.error(`[send-text:${id}] falhou ao enviar para ${jid}:`, (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

// mediaType: image | video | audio | document
messagesRouter.post("/sessions/:id/send-media", async (req, res) => {
  const { id } = req.params;
  const { to, mediaType, url, caption, filename } = req.body as {
    to?: string;
    mediaType?: "image" | "video" | "audio" | "document";
    url?: string;
    caption?: string;
    filename?: string;
  };
  if (!to || !mediaType || !url) {
    return res.status(400).json({ error: "to, mediaType and url are required" });
  }

  const sock = requireSocket(id, res);
  if (!sock) {
    console.warn(`[send-media:${id}] rejeitado — sessão não conectada (to=${to}, tipo=${mediaType})`);
    return;
  }

  const jid = toJid(to);
  console.log(`[send-media:${id}] enviando ${mediaType} para ${jid}`);
  try {
    let content: Record<string, unknown>;

    if (mediaType === "document") {
      content = { document: { url }, fileName: filename, caption };
      const isPdf = /\.pdf($|\?)/i.test(filename ?? url);
      if (isPdf) {
        try {
          const pdfRes = await fetch(url);
          if (pdfRes.ok) {
            const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
            const thumb = await pdfFirstPageThumbnail(pdfBuffer);
            if (thumb) {
              content.jpegThumbnail = thumb;
              console.log(`[send-media:${id}] miniatura de PDF gerada (${thumb.length} bytes)`);
            }
          } else {
            console.warn(`[send-media:${id}] não consegui baixar o PDF pra gerar miniatura [${pdfRes.status}]`);
          }
        } catch (thumbErr) {
          console.error(`[send-media:${id}] falha ao gerar miniatura do PDF`, (thumbErr as Error).message);
        }
      }
    } else {
      content =
        mediaType === "image"
          ? { image: { url }, caption }
          : mediaType === "video"
          ? { video: { url }, caption }
          : { audio: { url }, ptt: true, mimetype: "audio/ogg; codecs=opus" };
    }

    const sent = await sock.sendMessage(jid, content as any);
    console.log(`[send-media:${id}] enviado com sucesso — provider_message_id=${sent?.key?.id}`);
    res.json({ provider_message_id: sent?.key?.id ?? null, resolved_jid: jid });
  } catch (err) {
    console.error(`[send-media:${id}] falhou ao enviar ${mediaType} para ${jid}:`, (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

messagesRouter.post("/sessions/:id/typing", async (req, res) => {
  const { id } = req.params;
  const { to, duration_ms } = req.body as { to?: string; duration_ms?: number };
  if (!to) return res.status(400).json({ error: "to is required" });

  const sock = requireSocket(id, res);
  if (!sock) return;

  try {
    const jid = toJid(to);
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((r) => setTimeout(r, Math.min(duration_ms ?? 1200, 5000)));
    await sock.sendPresenceUpdate("paused", jid);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
