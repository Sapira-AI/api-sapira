import { Inject, Injectable, Logger } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { DataSource } from 'typeorm';

import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

import {
	BackfillFacturaDto,
	BackfillOmitidaDto,
	BackfillResultadoDto,
	CampoBackfill,
	CAMPOS_BACKFILL_POR_DEFECTO,
	MotivoOmisionBackfill,
} from '../dtos/odoo-invoice-backfill.dto';
import { determinarEstadoSapira } from '../helpers/odoo-invoice-status.helper';
import { OdooInvoiceSyncFields } from '../interfaces/odoo.interface';
import { OdooInvoicesService } from '../odoo-invoices.service';
import { OdooInvoiceUpdateLog, OdooInvoiceUpdateLogSchema } from '../schemas/odoo-invoice-update-log.schema';

/** Las seis columnas que el backfill puede tocar; cuáles de verdad escribe lo decide `campos`. */
type CamposSincronizados = Pick<Invoice, 'invoice_number' | 'status' | 'vat' | 'total_invoice_currency' | 'amount_invoice_currency' | 'issue_date'>;

type FilaCandidata = {
	id: string;
	odoo_invoice_id: string | number;
	invoice_number: string | null;
	status: string | null;
	vat: string | number | null;
	total_invoice_currency: string | number | null;
	amount_invoice_currency: string | number | null;
	issue_date: Date | string | null;
	sent_to_odoo_at: Date | null;
};

/**
 * Recupera en Sapira el folio y el estado de las facturas cuyo aviso de Odoo nunca llegó.
 *
 * **Por qué existe:** el aviso del webhook es la única fuente de `invoice_number` y del avance a
 * `Enviada`/`Pagada` (el scheduler escribe `odoo_invoice_id` y `status='Emitida'`, nunca el folio).
 * Entre el 16 y el 28-09-2026 la automated action de Odoo apuntaba a la URL vieja de Railway, dada
 * de baja al pasar a `api.aisapira.com`, y quedaron 154 facturas publicadas en Odoo y sin folio
 * en Sapira.
 *
 * **Por qué lee Odoo en vez de reenviar los avisos:** preguntarle a Odoo por `odoo_invoice_id` es
 * idempotente y se puede correr en seco, mientras que re-disparar la automation obliga a escribir
 * 154 veces sobre facturas ya publicadas.
 *
 * **Las tres guardas**, porque esto escribe sobre facturas emitidas en pleno cierre de mes:
 * 1. `aplicar` es `false` por defecto: sin pedirlo explícito, solo informa.
 * 2. Se exige que `x_sapira_invoice_id` de Odoo coincida con el id de la factura de Sapira. Sin esa
 *    comprobación, un `odoo_invoice_id` desalineado escribiría el folio en la factura equivocada.
 * 3. Solo se sincroniza lo que Odoo tiene en `posted`: un borrador no tiene folio que traer.
 */
@Injectable()
export class OdooInvoiceBackfillService {
	private readonly logger = new Logger(OdooInvoiceBackfillService.name);
	private readonly invoiceUpdateLogModel: Model<any>;

	/** Tope por corrida. Más que esto se parte en varias, para no dejar una transacción enorme abierta. */
	private static readonly MAXIMO_POR_CORRIDA = 1000;

	constructor(
		@Inject('DbConnectionToken') connection: Connection,
		private readonly dataSource: DataSource,
		private readonly odooInvoicesService: OdooInvoicesService
	) {
		this.invoiceUpdateLogModel = connection.model(OdooInvoiceUpdateLog.name, OdooInvoiceUpdateLogSchema);
	}

	async backfillFolios(
		holdingId: string,
		opciones: { dias?: number; aplicar?: boolean; odooInvoiceIds?: number[]; campos?: CampoBackfill[]; estados?: string[] } = {}
	): Promise<BackfillResultadoDto> {
		const aplicar = opciones.aplicar === true;
		const campos = opciones.campos?.length ? opciones.campos : CAMPOS_BACKFILL_POR_DEFECTO;
		const candidatas = await this.buscarCandidatas(holdingId, opciones);

		const resultado: BackfillResultadoDto = {
			generado_en: new Date(),
			holding_id: holdingId,
			aplicado: aplicar,
			campos,
			candidatas: candidatas.length,
			leidas_de_odoo: 0,
			con_cambios: 0,
			actualizadas: 0,
			sin_cambios: 0,
			omitidas: [],
			facturas: [],
			tope_alcanzado: candidatas.length >= OdooInvoiceBackfillService.MAXIMO_POR_CORRIDA,
		};

		if (candidatas.length === 0) return resultado;

		const porOdooId = new Map(candidatas.map((fila) => [Number(fila.odoo_invoice_id), fila]));
		const enOdoo = await this.odooInvoicesService.readInvoicesForSync(holdingId, [...porOdooId.keys()]);

		resultado.leidas_de_odoo = enOdoo.length;

		const leidos = new Set(enOdoo.map((factura) => Number(factura.id)));
		for (const [odooId, fila] of porOdooId) {
			if (!leidos.has(odooId)) {
				resultado.omitidas.push(this.omitir(fila, 'no_existe_en_odoo'));
			}
		}

		for (const facturaOdoo of enOdoo) {
			const fila = porOdooId.get(Number(facturaOdoo.id));
			if (!fila) continue;

			const omision = this.motivoDeOmision(fila, facturaOdoo);
			if (omision) {
				resultado.omitidas.push(this.omitir(fila, omision));
				continue;
			}

			const nuevos = this.camposDesdeOdoo(facturaOdoo, campos);
			const cambios = this.detectarCambios(fila, nuevos);

			if (cambios.length === 0) {
				resultado.sin_cambios += 1;
				continue;
			}

			resultado.con_cambios += 1;
			resultado.facturas.push({
				id: fila.id,
				odoo_invoice_id: Number(facturaOdoo.id),
				cambios,
				aplicado: aplicar,
			});

			if (aplicar) {
				await this.aplicarCambios(holdingId, fila, facturaOdoo, nuevos, cambios);
				resultado.actualizadas += 1;
			}
		}

		this.logger.log(
			`Backfill ${aplicar ? 'aplicado' : 'en seco'} para el holding ${holdingId}: ` +
				`${resultado.candidatas} candidatas · ${resultado.leidas_de_odoo} leídas de Odoo · ` +
				`${resultado.con_cambios} con cambios · ${resultado.actualizadas} actualizadas · ${resultado.omitidas.length} omitidas`
		);

		return resultado;
	}

	/**
	 * Las candidatas son las mismas que cuenta `facturas_sin_folio` del diagnóstico: enviadas a Odoo
	 * y todavía sin folio. Con `odooInvoiceIds` se acota a una lista concreta, para recuperar un caso
	 * puntual sin barrer el mes.
	 */
	private async buscarCandidatas(
		holdingId: string,
		opciones: { dias?: number; odooInvoiceIds?: number[]; estados?: string[] }
	): Promise<FilaCandidata[]> {
		const ids = opciones.odooInvoiceIds?.length ? opciones.odooInvoiceIds : null;
		const estados = opciones.estados?.length ? opciones.estados : null;
		const desde = opciones.dias ? new Date(Date.now() - Math.min(Math.max(opciones.dias, 1), 365) * 24 * 60 * 60 * 1000) : null;

		return await this.dataSource.query<FilaCandidata[]>(
			`SELECT i.id, i.odoo_invoice_id, i.invoice_number, i.status, i.vat, i.total_invoice_currency,
					i.amount_invoice_currency, i.issue_date, i.sent_to_odoo_at
			   FROM invoices i
			  WHERE i.holding_id = $1::uuid
				AND i.odoo_invoice_id IS NOT NULL
				AND i.invoice_number IS NULL
				AND ($2::timestamptz IS NULL OR i.sent_to_odoo_at >= $2::timestamptz)
				AND ($3::int[] IS NULL OR i.odoo_invoice_id = ANY($3::int[]))
				AND ($4::text[] IS NULL OR i.status = ANY($4::text[]))
			  ORDER BY i.sent_to_odoo_at
			  LIMIT $5`,
			[holdingId, desde, ids, estados, OdooInvoiceBackfillService.MAXIMO_POR_CORRIDA]
		);
	}

	/** Las guardas 2 y 3: amarre correcto y factura publicada. */
	private motivoDeOmision(fila: FilaCandidata, facturaOdoo: OdooInvoiceSyncFields): MotivoOmisionBackfill | null {
		const amarre = this.texto(facturaOdoo.x_sapira_invoice_id);

		if (!amarre) return 'sin_x_sapira_invoice_id_en_odoo';
		if (amarre !== fila.id) return 'x_sapira_invoice_id_no_coincide';
		if (this.texto(facturaOdoo.state) !== 'posted') return 'no_publicada_en_odoo';
		if (!this.texto(facturaOdoo.name)) return 'sin_folio_en_odoo';

		return null;
	}

	/**
	 * Qué se escribe, según los grupos pedidos en `campos`.
	 *
	 * El default es `['folio', 'estado']` y no es una preferencia de estilo: **`montos` y `fecha`
	 * requieren reconstruir el cronograma de revenue a mano.** `trg_rsm_on_invoice_change` dispara
	 * cuando cambian `total_invoice_currency` o `issue_date`, pero su función sale en seco con la
	 * conexión de la API —lee `get_current_user_holding_id()` → `rls_user_holding_id()`, que necesita
	 * claims del JWT, y la API entra con el rol `postgres` sin claims—, así que
	 * `revenue_schedule_monthly` se quedaría con los números viejos y Sapira se desalinearía en
	 * silencio. Medido el 01-10-2026 en el holding de SimpliRoute: de 233 facturas con cambios, los
	 * deltas de monto llegaban a seis cifras y había una `issue_date` con el año equivocado.
	 *
	 * `folio` y `estado` son seguros: `Emitida`, `Enviada` y `Pagada` están en los mismos filtros
	 * `IN` del rebuild, así que moverse entre ellos no cambia ningún `billed_*`.
	 * ⚠️ `Por Emitir → Enviada` **sí** cambia revenue: ese estado no entra en esos filtros.
	 */
	private camposDesdeOdoo(facturaOdoo: OdooInvoiceSyncFields, campos: CampoBackfill[]): CamposSincronizados {
		const sincronizados: CamposSincronizados = {};

		if (campos.includes('folio')) {
			sincronizados.invoice_number = this.texto(facturaOdoo.name);
		}

		if (campos.includes('estado')) {
			// `motivoDeOmision` ya garantizó `state === 'posted'`, así que nunca es null acá.
			sincronizados.status = determinarEstadoSapira(this.texto(facturaOdoo.state), this.texto(facturaOdoo.payment_state)) ?? undefined;
		}

		if (campos.includes('montos')) {
			const vat = this.numero(facturaOdoo.amount_tax);
			if (vat !== undefined) sincronizados.vat = vat;

			const total = this.numero(facturaOdoo.amount_total);
			if (total !== undefined) sincronizados.total_invoice_currency = total;

			const neto = this.numero(facturaOdoo.amount_untaxed);
			if (neto !== undefined) sincronizados.amount_invoice_currency = neto;
		}

		if (campos.includes('fecha')) {
			// Igual que el webhook: la fecha va como string `YYYY-MM-DD` para que no la corra el UTC.
			const fecha = this.texto(facturaOdoo.invoice_date);
			if (fecha) sincronizados.issue_date = fecha as unknown as Date;
		}

		return sincronizados;
	}

	private detectarCambios(fila: FilaCandidata, nuevos: CamposSincronizados): BackfillFacturaDto['cambios'] {
		const cambios: BackfillFacturaDto['cambios'] = [];

		const comparar = (campo: string, actual: unknown, nuevo: unknown) => {
			if (nuevo === undefined) return;
			if (this.mismoValor(actual, nuevo)) return;

			cambios.push({ campo, antes: actual === null ? undefined : String(actual), despues: String(nuevo) });
		};

		comparar('invoice_number', fila.invoice_number, nuevos.invoice_number);
		comparar('status', fila.status, nuevos.status);
		comparar('vat', fila.vat, nuevos.vat);
		comparar('total_invoice_currency', fila.total_invoice_currency, nuevos.total_invoice_currency);
		comparar('amount_invoice_currency', fila.amount_invoice_currency, nuevos.amount_invoice_currency);
		comparar('issue_date', this.soloFecha(fila.issue_date), nuevos.issue_date);

		return cambios;
	}

	/**
	 * Escribe y deja el rastro en `odoo_invoice_update_logs`, la misma colección que usa el webhook,
	 * con `skip_reason: 'backfill'` para poder distinguir después qué vino por aviso y qué a mano.
	 */
	private async aplicarCambios(
		holdingId: string,
		fila: FilaCandidata,
		facturaOdoo: OdooInvoiceSyncFields,
		nuevos: CamposSincronizados,
		cambios: BackfillFacturaDto['cambios']
	): Promise<void> {
		await this.dataSource.getRepository(Invoice).update(fila.id, nuevos);

		const log = new this.invoiceUpdateLogModel({
			sapira_invoice_id: fila.id,
			odoo_invoice_id: Number(facturaOdoo.id),
			holding_id: holdingId,
			webhook_payload: { origen: 'backfill', leido_de_odoo: facturaOdoo },
			was_updated: true,
			fields_changed: cambios.map((cambio) => cambio.campo),
			old_values: Object.fromEntries(cambios.map((cambio) => [cambio.campo, cambio.antes])),
			new_values: Object.fromEntries(cambios.map((cambio) => [cambio.campo, cambio.despues])),
			skip_reason: 'backfill',
		});

		await log.save();
	}

	private omitir(fila: FilaCandidata, motivo: MotivoOmisionBackfill): BackfillOmitidaDto {
		return { id: fila.id, odoo_invoice_id: Number(fila.odoo_invoice_id), motivo };
	}

	/** Odoo devuelve `false` en vez de null cuando un campo está vacío. */
	private texto(valor: string | false | undefined): string | undefined {
		return typeof valor === 'string' && valor !== '' ? valor : undefined;
	}

	private numero(valor: number | false | undefined): number | undefined {
		return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined;
	}

	private soloFecha(valor: Date | string | null): string | undefined {
		if (!valor) return undefined;

		return (valor instanceof Date ? valor.toISOString() : String(valor)).split('T')[0];
	}

	/** `numeric` de PostgreSQL llega como string, así que las cifras se comparan como números. */
	private mismoValor(actual: unknown, nuevo: unknown): boolean {
		if (actual === null || actual === undefined) return false;

		if (typeof nuevo === 'number') {
			const actualNumero = Number(actual);
			return Number.isFinite(actualNumero) && actualNumero === nuevo;
		}

		return String(actual) === String(nuevo);
	}
}
