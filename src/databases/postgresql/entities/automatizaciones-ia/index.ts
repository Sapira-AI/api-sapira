/**
 * Espejo del módulo `automatizaciones-ia`: 10 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 10. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { Agent } from './agent.entity';
export { AgentLog } from './agent-log.entity';
export { AiAgent } from './ai-agent.entity';
export { AiAgentConfig } from './ai-agent-config.entity';
export { AiMessage } from './ai-message.entity';
export { AiRun } from './ai-run.entity';
export { ClientAgentConfig } from './client-agent-config.entity';
export { EmailSenderAddress } from './email-sender-address.entity';
export { HoldingEmailSenderSettings } from './holding-email-sender-settings.entity';
export { RagDocument } from './rag-document.entity';
