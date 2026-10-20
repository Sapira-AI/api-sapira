import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

import { KAME_REQUESTS_PER_MINUTE } from './kame.types';

/** Credencial ya descifrada de una conexión (nunca sale de la API). */
export interface KameCredential {
	/** Clave del caché de token: el id de la conexión. */
	key: string;
	clientId: string;
	clientSecret: string;
}

/** Error de la API de Kame, con un mensaje para la persona. `retryable` = vale la pena reintentar (red, límite, 5xx). */
export class KameApiError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly retryable: boolean,
		readonly response?: unknown
	) {
		super(message);
		this.name = 'KameApiError';
	}
}

/** Respuesta de `addVenta` (`{ Estado, Id, Fecha, Folio, Error }`); la de NC y comprobante no está documentada y se guarda tal cual. */
export interface KameWriteResult {
	ok: boolean;
	id: string | null;
	folio: string | null;
	error: string | null;
	raw: unknown;
}

const TOKEN_MARGIN_MS = 60_000;

/** Mensaje legible de una respuesta de error de Kame (`Error`, `message`, texto plano). */
function kameErrorText(data: unknown): string | null {
	if (!data) return null;
	if (typeof data === 'string') return data.trim().startsWith('<') ? null : data.slice(0, 300);
	const record = data as Record<string, unknown>;
	const value = record.Error ?? record.error ?? record.message ?? record.Message ?? record.error_description;

	return value == null ? null : typeof value === 'string' ? value : JSON.stringify(value).slice(0, 300);
}

/** Lee el resultado de una escritura: `Estado: "Ok"` o, si no lo trae, la ausencia de `Error`. */
export function readWriteResult(data: unknown): KameWriteResult {
	const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
	const error = kameErrorText(record.Error ?? record.error ?? null);
	const estado = String(record.Estado ?? record.estado ?? '').toLowerCase();
	const ok = estado ? estado === 'ok' : !error;
	const id = record.Id ?? record.id ?? record.IdVenta ?? record.idComprobante ?? null;
	const folio = record.Folio ?? record.folio ?? null;

	return {
		ok,
		id: id == null ? null : String(id),
		folio: folio == null ? null : String(folio),
		error: ok ? null : (error ?? 'Kame rechazó el registro'),
		raw: data,
	};
}

/**
 * Cliente de la API de Kame (`https://api.kameone.cl`, documentación en `README.md` del módulo):
 * - token Auth0 por `client_credentials` con `audience` = `<base>/api`, guardado en memoria por conexión hasta 1 min antes de vencer
 *   (dura 24 h);
 * - límite propio de 150 peticiones por minuto (Kame bloquea la IP sobre 180 con un 403 del firewall);
 * - errores normalizados en `KameApiError`: el 401 renueva el token una vez; 403/429/5xx y red son reintentables.
 */
@Injectable()
export class KameClientService {
	private readonly logger = new Logger(KameClientService.name);
	private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
	private readonly sentAt: number[] = [];
	private readonly http: AxiosInstance;

	constructor() {
		this.http = axios.create({ baseURL: `${this.baseUrl}/api`, timeout: 60_000 });
	}

	get baseUrl(): string {
		return (process.env.KAME_API_URL ?? 'https://api.kameone.cl').replace(/\/$/, '');
	}

	/** Pide el token (o usa el guardado). Lanza `KameApiError` con un mensaje para la persona si la credencial no sirve. */
	async token(credential: KameCredential, force = false): Promise<string> {
		const cached = this.tokens.get(credential.key);

		if (!force && cached && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) return cached.value;
		try {
			const { data } = await axios.post(
				`${this.baseUrl}/oauth/token`,
				{
					client_id: credential.clientId,
					client_secret: credential.clientSecret,
					audience: `${this.baseUrl}/api`,
					grant_type: 'client_credentials',
				},
				{ headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
			);

			if (!data?.access_token) throw new KameApiError('Kame no entregó un token', null, true, data);
			this.tokens.set(credential.key, { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 86_400) * 1000 });

			return data.access_token;
		} catch (error) {
			if (error instanceof KameApiError) throw error;
			const status = (error as AxiosError).response?.status ?? null;

			if (status === 401 || status === 403 || status === 400) {
				throw new KameApiError('Kame rechazó el client ID o el client secret', status, false, (error as AxiosError).response?.data);
			}
			throw this.toError(error as AxiosError);
		}
	}

	forgetToken(key: string): void {
		this.tokens.delete(key);
	}

	listBusinessUnits(credential: KameCredential): Promise<unknown> {
		return this.request(credential, 'get', '/Maestro/getListUnidadNegocio');
	}

	getSale(credential: KameCredential, documento: string, folio: number | string): Promise<unknown> {
		return this.request(credential, 'get', `/Documento/getVenta/${encodeURIComponent(documento)}/${encodeURIComponent(String(folio))}`);
	}

	async write(credential: KameCredential, endpoint: string, body: unknown): Promise<KameWriteResult> {
		return readWriteResult(await this.request(credential, 'post', endpoint, body));
	}

	private async request<T = unknown>(
		credential: KameCredential,
		method: 'get' | 'post',
		path: string,
		body?: unknown,
		retried = false
	): Promise<T> {
		await this.throttle();
		const token = await this.token(credential);

		try {
			const response = await this.http.request<T>({ method, url: path, data: body, headers: { Authorization: `Bearer ${token}` } });

			return response.data;
		} catch (error) {
			const axiosError = error as AxiosError;

			if (axiosError.response?.status === 401 && !retried) {
				this.forgetToken(credential.key);

				return this.request(credential, method, path, body, true);
			}
			throw this.toError(axiosError);
		}
	}

	private toError(error: AxiosError): KameApiError {
		const status = error.response?.status ?? null;
		const data = error.response?.data;
		const detail = kameErrorText(data);

		if (status === null) return new KameApiError(`No se pudo conectar con Kame (${error.code ?? error.message})`, null, true);
		// El firewall de Kame responde 403 sin cuerpo útil al pasar 180 peticiones por minuto.
		if (status === 403 && !detail) return new KameApiError('Kame limitó las peticiones por minuto: se reintenta más tarde', status, true, data);
		if (status === 429 || status >= 500) return new KameApiError(detail ?? `Kame no respondió (HTTP ${status})`, status, true, data);

		return new KameApiError(detail ?? `Kame rechazó la petición (HTTP ${status})`, status, false, data);
	}

	/** Ventana deslizante de un minuto: espera lo justo para no pasar de `KAME_REQUESTS_PER_MINUTE`. */
	private async throttle(): Promise<void> {
		const now = Date.now();

		while (this.sentAt.length && now - this.sentAt[0] > 60_000) this.sentAt.shift();
		if (this.sentAt.length >= KAME_REQUESTS_PER_MINUTE) {
			const wait = 60_000 - (now - this.sentAt[0]) + 50;

			this.logger.warn(`Límite de peticiones a Kame: espero ${wait} ms`);
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
		this.sentAt.push(Date.now());
	}
}
