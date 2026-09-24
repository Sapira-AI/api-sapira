import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Bucket privado de documentos de clientes (migración `1790272076545`). */
export const CLIENT_FILES_BUCKET = 'client-files';
/** Vigencia de las URLs firmadas de descarga (segundos): cortas, se piden al abrir. */
const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Acceso a Supabase Storage con la clave de servicio, solo desde la API. El navegador nunca recibe la clave: sube
 * con una URL firmada de subida y descarga con una URL firmada de corta duración (regla de `AGENTS.md`).
 */
@Injectable()
export class ClientFilesStorageService {
	private readonly logger = new Logger(ClientFilesStorageService.name);
	private client: SupabaseClient | null = null;

	constructor(private readonly config: ConfigService) {}

	private storage() {
		if (!this.client) {
			const url = this.config.get<string>('SUPABASE_URL');
			const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

			if (!url || !key) throw new ServiceUnavailableException('Storage no está configurado (falta SUPABASE_SERVICE_ROLE_KEY)');
			this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
		}

		return this.client.storage.from(CLIENT_FILES_BUCKET);
	}

	async createUploadUrl(path: string): Promise<{ signedUrl: string; token: string }> {
		const { data, error } = await this.storage().createSignedUploadUrl(path);

		if (error || !data) {
			this.logger.error(`No se pudo firmar la subida de ${path}: ${error?.message}`);
			throw new InternalServerErrorException('No se pudo preparar la subida del archivo');
		}

		return { signedUrl: data.signedUrl, token: data.token };
	}

	/** Tamaño del objeto si existe (para confirmar que la subida terminó); `null` si no está. */
	async objectSize(path: string): Promise<number | null> {
		const folder = path.slice(0, path.lastIndexOf('/'));
		const name = path.slice(path.lastIndexOf('/') + 1);
		const { data, error } = await this.storage().list(folder, { search: name, limit: 1 });

		if (error) throw new InternalServerErrorException('No se pudo verificar el archivo subido');
		const object = data?.find((item) => item.name === name);

		return object ? Number((object.metadata as { size?: number } | null)?.size ?? 0) : null;
	}

	/** URL firmada para abrir el archivo (el navegador lo muestra si puede, p. ej. un PDF). */
	async createDownloadUrl(path: string): Promise<string> {
		const { data, error } = await this.storage().createSignedUrl(path, DOWNLOAD_URL_TTL_SECONDS);

		if (error || !data) throw new InternalServerErrorException('No se pudo generar el enlace de descarga');

		return data.signedUrl;
	}
}
