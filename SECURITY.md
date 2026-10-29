# Política de segurança

## Versões suportadas

Só a versão publicada mais recente recebe correções de segurança. Atualize com `npm i -g andromeda-agent`.

## Como reportar

Use os **GitHub Security Advisories** deste repositório (aba Security, "Report a vulnerability"). O relato é privado. Não abra issue pública para vulnerabilidade.

Inclua a versão, o sistema operacional, os passos para reproduzir e o impacto que você enxerga.

## Prazo de resposta

Confirmamos o recebimento em até 7 dias e damos um parecer inicial em até 14 dias. Este é um projeto mantido por uma pessoa; os prazos são de boa-fé, não um contrato.

## Escopo

Dentro: o que o agente lê, extrai e envia; o armazenamento do token e do estado local; o registro do serviço; a cadeia de publicação do pacote. Qualquer envio de dado que o [PRIVACY.md](PRIVACY.md) diz que nunca sai é uma vulnerabilidade.

Fora: falhas no servidor do Andromeda (reporte à sua organização), nas IAs que o agente lê e ataques que já exigem controle total da conta do usuário no computador.

## Práticas

- Publicação com **provenance** do npm, a partir de workflow manual e com aprovação.
- **Sem `postinstall`** nem scripts de instalação: nada roda ao instalar o pacote. O registro do serviço só acontece pelo comando `install`.
- Dependências mínimas e com versão travada.
- **Tokens opacos e curtos**, com refresh rotativo; o token não vai para log.
- A **URL do servidor só é definida pelo pareamento**; não vem de variável de ambiente nem de arquivo de configuração de outras ferramentas.
- Roda sem administrador, só no usuário.
