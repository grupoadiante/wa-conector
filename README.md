# wa-connector

Servidor próprio de conexão WhatsApp (Baileys) usado pelo Backster como "Meu Servidor".
Build: `2026-11-18-labels-mode-self-heal-v1`.

## O que mudou nesta versão

| Problema visto em 18/11 | Correção |
|---|---|
| Linha de etiquetas decifrava cópia de tudo o que o bot enviava e falhava em todas ("Over 2000 messages into the future") | Modo `labels`: o Baileys confirma e descarta as mensagens sem decifrar. Só processa o servidor do WhatsApp e o aparelho principal da conta (de onde vêm as chaves de sincronização das etiquetas) |
| Renegociação automática com o lead a cada 3 falhas, em todas as sessões | Removida no modo `labels`. No modo `full` só vale para mensagem recebida de lead, com teto de 4 por minuto por sessão |
| Bloqueio automático de contato no WhatsApp | Removido. O conector nunca mais bloqueia ninguém |
| 17 sessões sem pareamento em laço de QR a cada 2 minutos | QR expirado para a sessão de vez. Sessão sem pareamento só abre com pedido explícito (painel/API) |
| Qualquer erro solto encerrava o processo e derrubava todas as sessões | Erro é logado e contado. O processo só reinicia com mais de 40 erros soltos em 1 minuto |
| Lista de etiquetas vazia para sempre quando o evento se perdia | `POST /sessions/:id/labels/resync` e releitura automática pela auto-cura |
| Reconexão sempre em 2 a 15 s, sem limite | Espera crescente por sessão (2 s, 4 s, 8 s... até 5 min), zerada após 1 minuto estável |
| Log imprimia chaves privadas das sessões e centenas de linhas por minuto | Despejos do libsignal descartados; webhook entregue não é mais logado; falha de decriptação vira uma linha curta |
| Várias etiquetas ao mesmo tempo no mesmo número | Fila por número, uma por vez, com pausa de 700 ms e limite de 20 s por operação |

## Modos de sessão

- `labels` (padrão): linha usada só para etiquetar. Não recebe nem repassa mensagens, não baixa mídia, não aparece "online".
- `full`: linha de atendimento completa (recebe, envia, repassa ao webhook).

O modo vem de, nesta ordem: body de `POST /sessions/:id` (`{"mode":"full"}`), modo já gravado na sessão, variável `DEFAULT_SESSION_MODE`.

**Atenção:** com o padrão `labels`, uma sessão criada sem informar o modo não recebe mensagens. Se algum número usar o conector para atender, crie a sessão com `{"mode":"full"}` ou defina `DEFAULT_SESSION_MODE=full`.

## Auto-cura periódica

A cada 3 minutos (`SELF_HEAL_INTERVAL_MS`) o conector percorre as sessões e:

1. religa sessão pareada que ficou sem socket;
2. reinicia sessão presa "conectando" há mais de 2 minutos;
3. corrige o status gravado quando o socket está aberto e avisa o CRM;
4. relê as etiquetas do WhatsApp quando a lista está vazia (no máximo 1 vez por hora por sessão);
5. apaga sessão nunca pareada e parada há mais de 24 h (`ORPHAN_TTL_HOURS`).

Faz no máximo 4 reinícios por rodada. Cada rodada escreve uma linha `[self-heal]` no log.

## Variáveis de ambiente

Obrigatórias (iguais às de antes): `CONNECTOR_API_KEY`, `REDIS_URL`, `WEBHOOK_URL`, `WEBHOOK_SECRET`.

Opcionais novas:

| Variável | Padrão | Para quê |
|---|---|---|
| `DEFAULT_SESSION_MODE` | `labels` | Modo de sessão criada sem informar o modo |
| `SELF_HEAL_INTERVAL_MS` | `180000` | Intervalo da auto-cura |
| `ORPHAN_TTL_HOURS` | `24` | Tempo até apagar sessão nunca pareada |
| `LABEL_OP_TIMEOUT_MS` | `20000` | Limite de tempo de uma operação de etiqueta |
| `LABEL_PACE_MS` | `700` | Pausa entre etiquetas do mesmo número |
| `FATAL_BURST` | `40` | Erros soltos por minuto que forçam reinício do processo |

Já existentes: `PORT`, `MEMORY_RESTART_LIMIT_MB`, `EVENT_LOOP_STALL_MS`.

## Rotas

As rotas antigas continuam iguais. Novas:

- `GET /sessions-health` — uma linha por sessão (status, modo, pareada, socket aberto, etiquetas no cache) e o resultado da última auto-cura.
- `GET /sessions/:id/health` — o mesmo para uma sessão.
- `POST /self-heal/run` — roda a auto-cura agora.
- `POST /sessions/:id/labels/resync` — relê as etiquetas do WhatsApp.

Respostas de etiqueta (`/labels`, `/labels/apply`, `/labels/remove`): `200` ok, `503` sessão não conectada, `504` tempo esgotado, `502` outro erro. O corpo sempre traz `{"ok":false,"error":"..."}` com o motivo.

## Depois de subir esta versão

1. Conferir a versão: `GET /version` deve mostrar `2026-11-18-labels-mode-self-heal-v1`.
2. Apagar as 17 sessões órfãs: `CONNECTOR_URL=... CONNECTOR_API_KEY=... bash scripts/apagar-orfas.sh`. Sem rodar o script, elas ficam paradas e são apagadas sozinhas em 24 h.
3. Parear de novo a linha de etiquetas do 7930 (`org_50b07d5e_mtu93c6k`): as chaves dela se perderam ("Invalid PreKey ID").
4. Conferir `GET /sessions-health`: as 9 linhas devem aparecer com `ws_open: true` e `labels` maior que zero. A do 8118 (`org_50b07d5e_muwyxkng`) deve ser relida sozinha na primeira auto-cura; se continuar em zero, chamar `POST /sessions/org_50b07d5e_muwyxkng/labels/resync`.

## Redis

As credenciais e chaves das sessões ficam só no Redis. Ele precisa de persistência ligada (AOF ou RDB) e política `maxmemory-policy noeviction`. Com descarte de chaves por memória, as sessões se corrompem sozinhas.

## O que não foi testado

Testado localmente, sem acesso ao WhatsApp: compilação, subida, religamento no boot, bloqueio do laço de sessão sem pareamento, espera crescente, auto-cura (remoção de órfã), rotas novas e códigos de resposta.

Não testado, porque exige um número real conectado: o filtro de mensagens do modo `labels` em produção, a releitura de etiquetas (`resync`) e o fluxo de leitura de QR. Acompanhe o log nas primeiras horas.
