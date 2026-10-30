# andromeda-agent

Agente local do Andromeda. Ele lê os logs que as IAs de programação já gravam na sua máquina e envia ao servidor do Andromeda só as **contagens de tokens**, por sessão e por hora, junto da tarefa da sprint que estava ativa. Nunca envia prompt, resposta, conteúdo de arquivo nem caminho local.

O código é aberto (MIT) para qualquer pessoa auditar o que é lido e enviado. Detalhes em [PRIVACY.md](PRIVACY.md).

## Requisitos

- Node.js 22.15 ou mais novo.
- Windows, macOS ou Linux. Não precisa de administrador.

## Instalação

Enquanto o pacote não está no npm, instale direto do GitHub. O mesmo comando atualiza para a versão mais nova:

```sh
npm i -g --install-links github:ViniciusVRodrigues/andromeda-agent
```

O `--install-links` é necessário: sem ele, o npm 11 deixa a instalação global apontando para uma pasta temporária, e o agente não abre. Na instalação o npm compila o agente (baixa o TypeScript só para isso) e pode avisar de `allow-scripts`; o aviso não impede a instalação.

O comando fica disponível como `andromeda-agent` (e como `andromeda`). Instale de forma global antes de rodar `install`: o serviço não funciona a partir do cache do `npx`.

## Comandos

| Comando | O que faz |
|---|---|
| `andromeda-agent pair <url-do-servidor>` | Liga este computador à sua conta do Andromeda. A URL do servidor só é aceita por aqui. |
| `andromeda-agent install [--no-ai]` | Registra o agente para iniciar sozinho no seu usuário (veja "Sobreviver a reinício") e liga o MCP e o hook no Claude Code e no Codex (veja "IAs marcam a tarefa sozinhas"). `--no-ai` pula as IAs. |
| `andromeda-agent uninstall` | Remove o registro do serviço. Com `--purge`, apaga também os dados locais e as credenciais. |
| `andromeda-agent unpair` | Apaga as credenciais locais (a revogação no servidor é pelo app web). |
| `andromeda-agent status` | Mostra se o serviço existe, se está ativo e o resultado da última execução. |
| `andromeda-agent doctor` | Confere requisitos, pareamento, IAs encontradas e conexão. |
| `andromeda-agent run` | Roda o agente em primeiro plano (é o que o serviço executa). `run --once` faz um ciclo e sai. |
| `andromeda-agent --dry-run [--day AAAA-MM-DD]` | Mostra o JSON exato que seria enviado, sem enviar nada e sem gravar nada no estado. |
| `andromeda-agent task <ref>` | Marca a tarefa ativa. O uso de IA sem tarefa do mesmo dia passa a apontar para ela (retroage). A marca expira sozinha na virada do dia local, ao trocar de branch e ao trocar de repositório; se a branch aponta outro item, a branch ganha e o agente avisa. Todo uso chega ao Andromeda como sugestão, para você confirmar em Uso de IA. |
| `andromeda-agent task --clear` | Tira a tarefa ativa. O `status` mostra se a tarefa está valendo, se a branch está ganhando ou se ela expirou. |
| `andromeda-agent task --list` | Lista as tarefas da sua sprint. |
| `andromeda-agent mcp` | Servidor MCP por stdio (`get_task`, `set_task`, `list_tasks`); quem o chama é a IA, não você. |
| `andromeda-agent hook <claude-code\|codex>` | Uso interno: o hook de início de sessão das IAs. Só anota, no seu computador, qual IA abriu sessão, em que pasta e quando. |

## Com que frequência ele envia

O agente envia o uso a cada **15 minutos** (e ao iniciar). A cada **minuto** ele só fala com o servidor, para avisar que está vivo e saber se há um pedido para ele.

Para não esperar: em Perfil → Conector de IA, use **Sincronizar agora**. O pedido chega ao agente em até cerca de 1 minuto. Versões abaixo da 0.3.0 não atendem esse pedido; atualize com o comando da [Instalação](#instalação).

O `andromeda-agent status` mostra quando será o próximo envio.

## IAs suportadas

**Claude Code**, **Codex**, **Gemini CLI**, **opencode** (1.x), **Kilo** (7.x) e **Cline** (extensão clássica, `ui_messages.json`).

Ainda não: Roo Code (não grava o modelo de cada requisição), Copilot no VS Code (conta a menos no modo agente e não separa o cache), Copilot CLI, opencode 2.x e Cline 4.x (formato sem confirmação). O `andromeda-agent doctor` mostra quantos logs de cada IA ele achou.

O agente só **lê** os logs dessas ferramentas. A única configuração de IA que ele altera é a do Claude Code e do Codex, e só no `install` (veja abaixo).

## IAs marcam a tarefa sozinhas

O `andromeda-agent install` liga o agente ao Claude Code e ao Codex, se as pastas deles existem (`CLAUDE_CONFIG_DIR` ou `~/.claude`; `CODEX_HOME` ou `~/.codex`). Assim a IA chama `set_task` quando você cita a tarefa (ex.: `AB#123`) e diz qual marcou.

- **Claude Code:** entrada `mcpServers.andromeda` no `.claude.json` (em `CLAUDE_CONFIG_DIR`, se definida, senão em `~/.claude.json`); `mcp__andromeda` em `permissions.allow` e um hook `SessionStart` no `settings.json`.
- **Codex:** bloco entre `# >>> andromeda-agent` e `# <<< andromeda-agent` no `config.toml` (`[mcp_servers.andromeda]`), um hook `SessionStart` no `hooks.json` e um bloco com uma linha de instrução no `AGENTS.md`.

Rodar `install` de novo troca o que é do agente, sem duplicar; o resto dos arquivos fica como está. Se o arquivo de configuração estiver ilegível, ou se você já tiver um `[mcp_servers.andromeda]` seu no Codex, o agente não mexe e avisa.

**Custo:** cerca de 85 a 350 tokens por sessão no Claude Code e cerca de 40 no Codex (medição no estudo da change).

**Como desligar:** `andromeda-agent install --no-ai` não toca nas IAs; `andromeda-agent uninstall` remove só o que o `install` pôs. O `status` e o `doctor` mostram o que está ligado.

## Onde fica o estado

| Sistema | Pasta |
|---|---|
| Windows | `%LOCALAPPDATA%\andromeda-agent` |
| macOS | `~/Library/Application Support/andromeda-agent` |
| Linux | `$XDG_STATE_HOME/andromeda-agent` ou `~/.local/state/andromeda-agent` |

Guarda o cursor de leitura, a fila local de envios pendentes e o sal da máquina. O token de acesso fica no cofre do sistema ou, sem cofre, num arquivo só seu.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `ANDROMEDA_AGENT_HOME` | Troca a pasta de estado (banco local, log, credenciais em arquivo). |
| `ANDROMEDA_AGENT_CREDENTIAL_STORE=file` | Guarda as credenciais em arquivo restrito ao usuário em vez do cofre do sistema. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `OPENCODE_DATA_DIR`, `OPENCODE_DB`, `KILO_DB`, `CLINE_DATA_DIR` | Os mesmos das próprias IAs: o agente lê os logs de onde elas gravam. |

## Sobreviver a reinício

`andromeda-agent install` cria, só para o seu usuário e sem admin:

- **Windows:** uma tarefa agendada `andromeda-agent` (ao entrar na sessão e ao desbloquear), sem janela.
- **macOS:** um LaunchAgent `dev.andromeda.agent` em `~/Library/LaunchAgents`.
- **Linux:** uma unit de usuário do systemd em `~/.config/systemd/user`. Para rodar sem sessão aberta, rode você mesma `loginctl enable-linger <seu-usuário>`; o agente nunca faz isso por conta própria. Sem systemd, use `andromeda-agent run` num terminal ou uma entrada de autostart XDG.

Nada é registrado na instalação do pacote (não há `postinstall`); só o comando `install` mexe no sistema.

## Desinstalar por completo

```sh
andromeda-agent uninstall      # remove a tarefa / LaunchAgent / unit
npm rm -g andromeda-agent      # remove o programa
```

Depois apague a pasta de estado (tabela acima) e a entrada `andromeda-agent` do cofre do sistema, se houver. Para apagar os dados já enviados, peça ao administrador da sua organização no Andromeda.

## Licença

MIT. Veja [LICENSE](LICENSE).
