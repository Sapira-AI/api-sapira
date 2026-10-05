import { DataSource } from 'typeorm';

export type AgentType = 'proforma' | 'collections';

export interface EmailSender {
	from_name: string;
	from_email: string;
	reply_to_email?: string | null;
}

/** Remitente cuando el holding no tiene ninguno activo. */
export const FALLBACK_EMAIL_SENDER: EmailSender = { from_name: 'Sapira', from_email: 'noreply@sapira.cl' };

/**
 * Configuración efectiva de un agente para un cliente (`client_agent_configs`):
 * 1. Fila propia del cliente → si está deshabilitada el cliente se omite (`null`); si no, su `config_json`.
 * 2. Fila global del holding (`client_id IS NULL`) → misma regla.
 * 3. Sin ninguna → `null` (el cliente se omite).
 */
export async function resolveEffectiveConfig(
	dataSource: DataSource,
	clientId: string,
	agentType: AgentType,
	holdingId: string
): Promise<Record<string, any> | null> {
	const rows = await dataSource.query(
		`SELECT client_id, is_enabled, config_json
		FROM client_agent_configs
		WHERE holding_id = $1 AND agent_type = $2 AND (client_id = $3 OR client_id IS NULL)
		ORDER BY client_id NULLS LAST
		LIMIT 1`,
		[holdingId, agentType, clientId]
	);
	const row = rows?.[0];

	if (!row || !row.is_enabled) return null;

	return row.config_json ?? {};
}

/**
 * Remitente efectivo: el `email_sender_address_id` de la configuración (si es del holding y está activo) o, si no, el remitente
 * activo del dominio por defecto del holding. `email_sender_addresses` cuelga de `holding_email_sender_settings` por
 * `domain_config_id`; antes se unía por una columna que no existe (`hess.email_sender_address_id`) y la consulta reventaba.
 */
export async function resolveEmailSender(dataSource: DataSource, config: Record<string, any>, holdingId: string): Promise<EmailSender> {
	const select = `
		SELECT esa.from_name, esa.from_email, esa.reply_to_email
		FROM email_sender_addresses esa
		INNER JOIN holding_email_sender_settings hess ON esa.domain_config_id = hess.id
		WHERE hess.holding_id = $1 AND hess.is_active = true AND esa.is_active = true`;

	if (config?.email_sender_address_id) {
		const chosen = await dataSource.query(`${select} AND esa.id = $2 LIMIT 1`, [holdingId, config.email_sender_address_id]);

		if (chosen?.length) return chosen[0];
	}

	const fallback = await dataSource.query(`${select} ORDER BY hess.is_default DESC, esa.is_default DESC, esa.from_name LIMIT 1`, [holdingId]);

	return fallback?.[0] ?? FALLBACK_EMAIL_SENDER;
}
