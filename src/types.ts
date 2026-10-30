// Tipos compartilhados entre os módulos. O contrato HTTP segue o design do
// endpoint v2 do Andromeda (seções 2 a 9).

export type ToolId = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'kilo' | 'cline';

export interface TokenCounts {
  /** Entrada sem cache. */
  input: number;
  /** Saída, já incluindo `thinking`. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Informativo; já contido em `output`. */
  thinking: number;
}

/**
 * Uma chamada de modelo, já normalizada pelo parser. Fica só na máquina:
 * `cwd` e `sessionId` nunca saem crus.
 */
export interface UsageEvent {
  tool: ToolId;
  /** Id estável da chamada (Claude: `message.id`; Codex: `response_id` ou derivado). */
  eventKey: string;
  sessionId: string;
  /** Instante em ms desde a época. */
  timestamp: number;
  model: string;
  /** Pasta da sessão, uso local (achar o remoto do git e o reflog). */
  cwd: string | null;
  /** Branch gravada no log, ou null (`HEAD` vira null). */
  branch: string | null;
  /** `log`: veio no registro; `none`: o parser não sabe. */
  branchSource: 'log' | 'none';
  tokens: TokenCounts;
}

/** Resultado de uma leitura incremental de um arquivo de log. */
export interface ParseResult {
  events: UsageEvent[];
  /** Deslocamento em bytes até onde foi consumido (só linhas completas). */
  nextOffset: number;
  /** Estado opaco do parser por arquivo (ex.: último total acumulado do Codex). */
  state?: string;
}

export interface LogParser {
  tool: ToolId;
  /** Lista os arquivos de log existentes, a partir da home do usuário. */
  discover(env: ParserEnv): Promise<string[]>;
  /**
   * Lê o arquivo a partir de `offset`. Arquivos comprimidos (`.zst`) são lidos
   * inteiros e o offset vale o tamanho descomprimido.
   */
  parse(file: string, offset: number, state: string | undefined): Promise<ParseResult>;
}

export interface ParserEnv {
  home: string;
  env: NodeJS.ProcessEnv;
}

export type AttributionMethod = 'explicit' | 'branch' | 'single-active' | 'none';

/** Linha do `POST /agent/v1/usage` (design 4.1). Montada só pela lista de permissão. */
export interface PayloadRow {
  key: string;
  tool: ToolId;
  sessionHash: string;
  model: string;
  /** Início da hora em UTC, `AAAA-MM-DDTHH:00:00Z`. */
  hour: string;
  /** Dia local do dev no início da janela, `AAAA-MM-DD`. */
  day: string;
  tokens: TokenCounts;
  interactions: number;
  origin: 'real' | 'estimado';
  repo: string | null;
  branch: string | null;
  taskRef: string | null;
  attributionMethod: AttributionMethod;
  /** true quando a branch é a atual da pasta, não a do instante do evento. */
  branchApproximate: boolean;
}

export type RowStatus = 'accepted' | 'duplicate' | 'rejected';

export interface RowResult {
  key: string;
  status: RowStatus;
  allocation?: 'ALLOCATED' | 'QUEUED' | 'HISTORY' | 'SUPERSEDED';
  workItemId?: string;
  taskRef?: string;
  reason?: string;
  retryable?: boolean;
  field?: string;
}

export interface UsageBatchResponse {
  batchId: string;
  accepted: number;
  duplicate: number;
  rejected: number;
  results: RowResult[];
}

export interface ActiveTask {
  workItemId: string;
  ref?: string;
  taskRef?: string;
  title: string;
  since: string;
  repository?: string | null;
}

export interface HeartbeatRequest {
  agentVersion: string;
  timezone: string;
  pendingRows: number;
  oldestPendingDay: string | null;
  /** O `syncRequestedAt` que o agente atendeu, devolvido como veio. */
  syncServed?: string;
}

export interface HeartbeatResponse {
  serverTime: string;
  minVersion: string;
  activeTask: ActiveTask | null;
  /** Pedido de sincronizar agora ainda não atendido; ausente em servidor antigo. */
  syncRequestedAt?: string | null;
}

export interface ReconcileDay {
  day: string;
  rows: number;
  tokens: TokenCounts;
  keysDigest: string;
}

export interface SetActiveTaskRequest {
  taskRef: string;
  since: string;
  day: string;
  repo?: string | null;
}

export interface SetActiveTaskResponse {
  workItemId: string;
  ref: string;
  title: string;
  retroactiveRows: number;
}

export interface TaskItem {
  workItemId: string;
  ref: string;
  externalId: string;
  title: string;
  type: string;
  sprintName: string;
}

/** `GET /agent/v1/work-item-patterns` (design 5.3 do endpoint v2). */
export interface WorkItemPatternsResponse {
  enabled: boolean;
  updatedAt: string | null;
  patterns: Array<{
    /** Regex Java, a que vale no servidor. */
    regex: string;
    preset: string;
    /** A mesma regex convertida para JavaScript, ou null sem conversão segura. */
    portable: { source: string; flags: string } | null;
  }>;
}

/** Credenciais do dispositivo, guardadas no cofre do SO (ou arquivo restrito). */
export interface DeviceCredentials {
  serverUrl: string;
  accessToken: string;
  refreshToken: string;
  /** Instante em ms em que o access token expira. */
  accessExpiresAt: number;
  deviceId: string;
  organizationSlug: string;
}

/**
 * Cliente do servidor. O `sync` depende só desta interface; o cliente HTTP real
 * fica em `client/http.ts` e os testes usam um falso.
 */
export interface AgentApi {
  uploadUsage(batchId: string, timezone: string, rows: PayloadRow[]): Promise<UsageBatchResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  reconcile(from: string, to: string): Promise<ReconcileDay[]>;
  usageKeys(day: string): Promise<string[]>;
  setActiveTask(req: SetActiveTaskRequest): Promise<SetActiveTaskResponse>;
  clearActiveTask(): Promise<void>;
  listTasks(): Promise<TaskItem[]>;
  workItemPatterns(): Promise<WorkItemPatternsResponse>;
}

/** Erros do cliente que o `sync` precisa distinguir. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    /** Segundos, quando o servidor mandou `Retry-After`. */
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Falha de lote inteiro que vale tentar de novo (rede, 5xx, 429). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export const AGENT_VERSION = '0.3.1';

/** Evento já com repositório e branch resolvidos localmente (P3), pronto para guardar. */
export interface ResolvedEvent extends UsageEvent {
  /** Remoto normalizado (`github.com/owner/repo`), sem credencial; null se não achou. */
  repo: string | null;
  /** Branch final: do log, do reflog no instante, ou a atual (aproximada). */
  resolvedBranch: string | null;
  /** true quando a branch é a atual da pasta, não a do instante do evento. */
  branchApprox: boolean;
}

/** Agregado local por (ferramenta, sessão, modelo, hora UTC, branch, repo). */
export interface Bucket {
  tool: ToolId;
  sessionId: string;
  model: string;
  /** Início da hora em UTC, ms. */
  hourStart: number;
  /** Dia local do início da hora, `AAAA-MM-DD`. */
  day: string;
  repo: string | null;
  branch: string | null;
  branchApprox: boolean;
  /** true: a chave leva o sufixo do repo (hora a partir de `key_repo_from`). */
  keyRepo: boolean;
  tokens: TokenCounts;
  /** Número de chamadas (eventos distintos) no bucket. */
  interactions: number;
}

/** Tarefa marcada pelo dev com `andromeda task X`, guardada localmente. */
export interface LocalActiveTask {
  taskRef: string;
  /** Instante em ms. */
  since: number;
  repo: string | null;
}
