/**
 * Espejo del módulo `automatizaciones-ia`: 10 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { Agent } from './agent.espejo';
export { AgentLog } from './agent-log.espejo';
export { AiAgent } from './ai-agent.espejo';
export { AiAgentConfig } from './ai-agent-config.espejo';
export { AiMessage } from './ai-message.espejo';
export { AiRun } from './ai-run.espejo';
export { ClientAgentConfig } from './client-agent-config.espejo';
export { EmailSenderAddress } from './email-sender-address.espejo';
export { HoldingEmailSenderSettings } from './holding-email-sender-settings.espejo';
export { RagDocument } from './rag-document.espejo';
