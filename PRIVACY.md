# Privacidade

Este documento diz o que o `andromeda-agent` lê, o que extrai e o que envia. O código é aberto: o que está aqui deve bater com ele. Se não bater, é um defeito e deve ser reportado (veja [SECURITY.md](SECURITY.md)).

## O que o agente lê

- **Claude Code:** `~/.claude/projects/**/*.jsonl`, ou a pasta de `$CLAUDE_CONFIG_DIR` quando definida.
- **Codex:** `~/.codex/sessions/**/rollout-*.jsonl` (e `.jsonl.zst`), ou a pasta de `$CODEX_HOME` quando definida.
- **Gemini CLI:** `~/.gemini/tmp/*/chats/session-*.jsonl` (e o `.json` antigo), ou a pasta de `$GEMINI_CLI_HOME` quando definida, e o `.project_root` de cada projeto.
- **opencode:** a base `opencode*.db` em `$OPENCODE_DATA_DIR`, `$XDG_DATA_HOME/opencode` ou `~/.local/share/opencode` (ou `$OPENCODE_DB`), aberta só para leitura.
- **Kilo:** a base `kilo*.db` em `$XDG_DATA_HOME/kilo` ou `~/.local/share/kilo` (ou `$KILO_DB`), aberta só para leitura.
- **Cline:** `tasks/*/ui_messages.json` e `task_metadata.json` na pasta da extensão (`globalStorage/saoudrizwan.claude-dev` do VS Code, Insiders, Cursor, VSCodium, Windsurf e Antigravity), ou `$CLINE_DATA_DIR`/`~/.cline/data`, e o `state/taskHistory.json` (só a pasta da tarefa).
- **git**, na pasta da sessão: `git remote get-url origin`, a branch atual e o reflog.

O agente só lê. Nunca altera a configuração nem os arquivos dessas ferramentas. Esses arquivos também guardam a conversa; dela o agente só pega os números de tokens, o modelo, o horário e os ids, e descarta o resto (no Cline, o campo `request`, que traz o prompt, nem é guardado).

## O que extrai

Contagens de tokens, modelo, horário, id da sessão, id da mensagem, pasta e branch. A **pasta fica só na máquina**: serve para achar o repositório e a branch, e não sai.

## O que é enviado, exatamente

Cada linha de uso:

`key, tool, sessionHash, model, hour, day, tokens{input,output,cacheRead,cacheWrite,thinking}, interactions, origin, repo, branch, branchApproximate, taskRef, attributionMethod`

`key` é opaca para o servidor: `ferramenta:sessionHash:modelo:hora:hash(branch):hash(repo)`, com os dois hashes de 6 caracteres do SHA-256. `taskRef` só vai quando você marcou a tarefa com `andromeda-agent task`; a tarefa tirada do nome da branch é resolvida pelo servidor, que recebe a branch e `attributionMethod`. `branchApproximate` diz se a branch é a atual da pasta, e não a do instante da chamada.

O agente também lê do servidor os padrões de branch da organização (`GET /agent/v1/work-item-patterns`), sem enviar nada seu nessa chamada.

Mais, no lote: `batchId, agentVersion, timezone`.

No heartbeat (uma vez por minuto): `agentVersion, timezone, pendingRows, oldestPendingDay` e, só depois de atender um pedido de "Sincronizar agora", `syncServed` (um instante que o próprio servidor mandou, devolvido como veio).

No pareamento: `agentVersion, machineName, os, osVersion, timezone`.

Para ver o JSON exato antes de qualquer envio, rode `andromeda-agent --dry-run`.

## O que nunca sai

Prompt, resposta da IA, conteúdo de arquivo, saída de ferramenta, caminho local, id cru da sessão e credencial do remoto do git (usuário, senha ou token embutidos na URL são descartados).

## Avisos honestos

- **O nome do repositório e o nome da branch saem em claro.** Se o nome de uma branch ou repositório é sensível, ele será enviado assim mesmo.
- O `sessionHash` é um hash do id da sessão com um **sal por máquina**, guardado só no seu computador: o servidor não consegue reverter nem ligar a mesma sessão entre máquinas.

## Telemetria própria

Nenhuma. O agente só fala com o servidor do Andromeda ao qual você o pareou. Não há analytics, relatório de falhas nem chamada a terceiros.

## Onde ficam token e estado

- **Token de acesso:** no cofre do sistema (Windows Credential Manager, macOS Keychain, Secret Service no Linux) ou, quando não há cofre, num arquivo com permissão restrita ao seu usuário.
- **Estado local** (cursor de leitura, fila de envios pendentes, sal): na pasta de estado descrita no [README](README.md).

## Como apagar tudo

1. `andromeda-agent uninstall` e `npm rm -g andromeda-agent`.
2. Apague a pasta de estado e a entrada `andromeda-agent` do cofre do sistema.
3. Os dados já enviados ficam no servidor da sua organização; a exclusão é pedida ao administrador dela.
