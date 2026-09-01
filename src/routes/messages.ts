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
      // Detecta PDF de verdade — por Content-Type e pelos magic bytes
      // (%PDF-), não só pelo nome/URL terminar em .pdf. Um gerador de PDF
      // dinâmico (ex: /orcamento/123/gerar-pdf) não tem extensão na URL, e
      // depender só do nome fazia a miniatura falhar silenciosamente pra
      // esses casos. Isso também evita baixar o arquivo duas vezes: já
      // aproveitamos esse fetch pra gerar a miniatura se for PDF.
      let isPdf = /\.pdf($|\?)/i.test(filename ?? url);
      let downloaded: Buffer | null = null;
      try {
        const docRes = await fetch(url);
        if (docRes.ok) {
          const contentType = docRes.headers.get("content-type") ?? "";
          downloaded = Buffer.from(await docRes.arrayBuffer());
          const looksLikePdf =
            contentType.toLowerCase().includes("application/pdf") ||
            downloaded.subarray(0, 5).toString("latin1") === "%PDF-";
          isPdf = isPdf || looksLikePdf;
        } else {
          console.warn(`[send-media:${id}] não consegui baixar o documento pra checar o tipo [${docRes.status}]`);
        }
      } catch (fetchErr) {
        console.error(`[send-media:${id}] falha ao baixar documento pra detecção de tipo`, (fetchErr as Error).message);
      }

      content = {
        document: { url },
        fileName: filename,
        caption,
        // O tipo do documento exige mimetype explícito — sem isso, alguns
        // clientes WhatsApp caem no ícone genérico em vez de tentar
        // renderizar a miniatura mesmo com jpegThumbnail presente.
        mimetype: isPdf ? "application/pdf" : "application/octet-stream",
      };
      if (isPdf && downloaded) {
        try {
          const thumb = await pdfFirstPageThumbnail(downloaded);
          if (thumb) {
            content.jpegThumbnail = thumb;
            console.log(`[send-media:${id}] miniatura de PDF gerada (${thumb.length} bytes)`);
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

// Força uma renegociação de sessão de criptografia (Signal) com um contato
// específico — busca um PreKey bundle novo do WhatsApp e sobrescreve
// qualquer sessão local corrompida. Usa isso quando um contato específico
// fica preso em "Aguardando mensagem" mesmo depois de reconectar a sessão
// inteira (reconectar não limpa o estado de criptografia por contato, só
// isso limpa).
messagesRouter.post("/sessions/:id/reset-peer-session", async (req, res) => {
  const { id } = req.params;
  const { to } = req.body as { to?: string };
  if (!to) return res.status(400).json({ error: "to is required" });

  const sock = requireSocket(id, res);
  if (!sock) return;

  try {
    const jid = toJid(to);
    console.log(`[reset-peer-session:${id}] forçando nova sessão com ${jid}`);
    const fetched = await sock.assertSessions([jid], true);
    console.log(`[reset-peer-session:${id}] sessão renegociada com ${jid} (fetched=${fetched})`);
    res.json({ ok: true, jid, fetched });
  } catch (err) {
    console.error(`[reset-peer-session:${id}] falhou para ${to}:`, (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});
