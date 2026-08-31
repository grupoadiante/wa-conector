import { downloadMediaMessage, getContentType, WAMessage, WASocket } from "@whiskeysockets/baileys";
import P from "pino";

const mediaLogger = P({ level: "error" });

// Tipos que carregam mídia baixável. Baileys usa a mesma chave pro conteúdo
// (ex: "imageMessage") tanto direto quanto dentro de mensagens efêmeras —
// getContentType já resolve isso.
const DOWNLOADABLE_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
]);

export function isDownloadableMedia(msg: WAMessage): boolean {
  const type = getContentType(msg.message ?? undefined);
  return !!type && DOWNLOADABLE_TYPES.has(type);
}

function mimeAndFilename(msg: WAMessage): { mimetype: string | null; filename: string | null } {
  const type = getContentType(msg.message ?? undefined);
  const content = (msg.message as any)?.[type as string];
  return {
    mimetype: content?.mimetype ?? null,
    filename: content?.fileName ?? null,
  };
}

export interface DownloadedMedia {
  base64: string;
  mimetype: string | null;
  filename: string | null;
}

// Baixa e decripta a mídia (só o socket com a sessão ativa consegue — as
// chaves de decriptação vivem aqui, não no lado do Supabase). O upload pro
// Storage é feito depois, no custom-webhook, que já tem acesso embutido às
// credenciais do Supabase sem precisar configurar nada extra aqui.
//
// O WhatsApp às vezes entrega a mesma mensagem em duas etapas: primeiro um
// "stub" sem conteúdo (falha de decriptação temporária), depois o conteúdo
// de verdade segundos depois, com o mesmo ID. Mesmo na segunda entrega, o
// arquivo de mídia pode ainda não estar totalmente disponível nos
// servidores do WhatsApp no instante exato em que tentamos baixar — por
// isso uma segunda tentativa curta antes de desistir.
export async function downloadMedia(
  sock: WASocket,
  sessionId: string,
  msg: WAMessage
): Promise<DownloadedMedia | null> {
  const msgId = msg.key?.id ?? "sem-id";

  for (const attempt of [1, 2]) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: mediaLogger, reuploadRequest: sock.updateMediaMessage }
      );
      if (!buffer || buffer.length === 0) {
        throw new Error("buffer vazio retornado pelo Baileys");
      }
      const { mimetype, filename } = mimeAndFilename(msg);
      console.log(`[media:${sessionId}] mídia ${msgId} baixada com sucesso (${buffer.length} bytes, tentativa ${attempt})`);
      return { base64: buffer.toString("base64"), mimetype, filename };
    } catch (err) {
      console.error(`[media:${sessionId}] falha ao baixar mídia ${msgId} (tentativa ${attempt}/2):`, (err as Error).message);
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  }

  console.error(`[media:${sessionId}] desisti de baixar a mídia ${msgId} após 2 tentativas`);
  return null;
}
