import { ConflictException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

import { CONTRACT_DOCUMENTS_BUCKET } from '../contract-360';

/** Vigencia de las URLs firmadas de descarga (segundos): cortas, se piden al descargar. */
export const CONTRACT_DOCUMENT_URL_TTL_SECONDS = 60;

/**
 * Acceso al bucket privado `contract-documents` con la clave de servicio, solo desde la API (misma regla que los
 * documentos de clientes: el navegador nunca recibe la clave, descarga con una URL firmada de corta duración).
 * Sin `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` responde 409 con un mensaje para la usuaria.
 */
@Injectable()
export class ContractDocumentsStorageService {
	private readonly logger = new Logger(ContractDocumentsStorageService.name);
	private client: SupabaseClient | null = null;

	constructor(private readonly config: ConfigService) {}

	private storage() {
		if (!this.client) {
			const url = this.config.get<string>('SUPABASE_URL');
			const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

			if (!url || !key) {
				throw new ConflictException(
					'La descarga de documentos no está disponible en este entorno: falta configurar el acceso al almacenamiento.'
				);
			}
			this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
		}

		return this.client.storage.from(CONTRACT_DOCUMENTS_BUCKET);
	}

	/** URL firmada para descargar el archivo y su vencimiento (ISO). */
	async createDownloadUrl(path: string, now = new Date()): Promise<{ url: string; expires_at: string }> {
		const { data, error } = await this.storage().createSignedUrl(path, CONTRACT_DOCUMENT_URL_TTL_SECONDS, { download: true });

		if (error || !data) {
			this.logger.error(`No se pudo firmar la descarga de ${path}: ${error?.message}`);
			throw new InternalServerErrorException('No se pudo generar el enlace de descarga');
		}

		return { url: data.signedUrl, expires_at: new Date(now.getTime() + CONTRACT_DOCUMENT_URL_TTL_SECONDS * 1000).toISOString() };
	}
}
