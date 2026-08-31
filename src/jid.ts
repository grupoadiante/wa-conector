// Converte um telefone (ou um JID já pronto) para o formato que o Baileys
// espera. Se o caller já mandar um chatId completo (ex: algo@lid ou
// algo@s.whatsapp.net), respeita — não reprocessa.
export function toJid(phoneOrJid: string): string {
  const raw = String(phoneOrJid ?? "").trim();
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}
