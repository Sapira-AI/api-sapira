import { randomUUID } from 'crypto';

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { withApiWriter } from '@/modules/contracts/api-writer';
import { todayFor } from '@/modules/contracts/business-date';
import { resolveUserId } from '@/modules/contracts/contract-drafts.service';
import { ContractsService } from '@/modules/contracts/contracts.service';
import { EmailsService } from '@/modules/emails/emails.service';

import { BillingReadService, mapInvoiceRow } from './billing-read.service';
import {
	type BillingBlocker,
	cleanEmails,
	escapeHtml,
	formatAmount,
	noContractBlocker,
	PAYMENT_EVENT_TYPES,
	reminderMatch,
	renderTemplate,
	TEMPLATE_VARIABLES,
	unknownTemplateVariables,
} from './billing-states';

import type { CollectionDto, CollectionSettingsDto, ProformaDto } from './dtos/billing.dto';

type Row = Record<string, unknown>;
type InvoiceView = ReturnType<typeof mapInvoiceRow>;
type TemplateValues = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string | null>>;

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

/** Defaults de `invoice_collection_settings` (los de la tabla) salvo `dunning_enabled`: apagado por defecto (Q5). */
export const DEFAULT_COLLECTION_SETTINGS = {
	dunning_enabled: false,
	email_from: null as string | null,
	bcc: null as string | null,
	reminder_days_before: [7, 3, 1],
	reminder_days_after: [1, 7, 15],
	email_subject_template: 'Recordatorio de pago factura {{invoice_number}}',
	email_body_template:
		'Estimado {{client_name}},\n\nLe recordamos que la factura {{invoice_number}} por {{amount_due}} vence el {{due_date}}.\n\nSaludos,\n{{company_name}}',
};

export type CollectionSettings = typeof DEFAULT_COLLECTION_SETTINGS & { exists: boolean; updated_at: string | null };

/** Tipo de contacto que prefiere la cobranza (si el cliente no tiene ninguno, van todos sus contactos con correo). */
const BILLING_CONTACT = /(factur|cobran|billing|pago|payment|finanz|financ|contab|account)/i;

export interface CollectionEmailPlan {
	client_id: string | null;
	client_name: string | null;
	recipients: string[];
	bcc: string[];
	subject: string;
	body_html: string;
	invoices: Array<{
		id: string;
		invoice_number: string | null;
		currency: string | null;
		balance: number | null;
		due_date: string | null;
		days_overdue: number;
	}>;
}

/**
 * Correos de Facturación v2 (spec §4.5, §4.6, §5.2): proforma, correo de cobro (una o lote, uno por cliente), configuración de recordatorios y
 * el job diario `billing-reminders`. Envío por `EmailsService.send` (SendGrid) con `bcc` real (B-F18: el viejo leía `email_bcc`), HTML
 * escapado y remitente del holding (`email_from`) o el del sistema (nunca `onboarding@resend.dev`). Registro en `invoice_emails` (proforma)
 * e `invoice_collection_logs` (cobro y recordatorios), en transacciones con `setApiWriter`.
 */
@Injectable()
export class BillingCollectionsService {
	private readonly logger = new Logger(BillingCollectionsService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly read: BillingReadService,
		private readonly emails: EmailsService,
		private readonly contracts: ContractsService,
		private readonly config: ConfigService
	) {}

	// ---------------------------------------------------------------- configuración

	async settings(holdingId: string): Promise<CollectionSettings> {
		const [row] = (await this.dataSource.query(
			`SELECT dunning_enabled, email_from, bcc, reminder_days_before, reminder_days_after, email_subject_template, email_body_template, updated_at
			FROM invoice_collection_settings WHERE holding_id = $1 LIMIT 1`,
			[holdingId]
		)) as Row[];

		if (!row) return { ...DEFAULT_COLLECTION_SETTINGS, exists: false, updated_at: null };

		return {
			dunning_enabled: row.dunning_enabled === true,
			email_from: text(row.email_from),
			bcc: text(row.bcc),
			reminder_days_before: Array.isArray(row.reminder_days_before) ? row.reminder_days_before.map(Number) : [],
			reminder_days_after: Array.isArray(row.reminder_days_after) ? row.reminder_days_after.map(Number) : [],
			email_subject_template: text(row.email_subject_template) ?? DEFAULT_COLLECTION_SETTINGS.email_subject_template,
			email_body_template: text(row.email_body_template) ?? DEFAULT_COLLECTION_SETTINGS.email_body_template,
			exists: true,
			updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : text(row.updated_at),
		};
	}

	async saveSettings(holdingId: string, dto: CollectionSettingsDto): Promise<CollectionSettings> {
		const errors = [
			...unknownTemplateVariables(dto.email_subject_template).map((name) => ({
				field: 'email_subject_template',
				message: `Variable desconocida {{${name}}}; usa: ${TEMPLATE_VARIABLES.join(', ')}`,
			})),
			...unknownTemplateVariables(dto.email_body_template).map((name) => ({
				field: 'email_body_template',
				message: `Variable desconocida {{${name}}}; usa: ${TEMPLATE_VARIABLES.join(', ')}`,
			})),
		];
		const bcc = dto.bcc ? cleanEmails([dto.bcc]) : [];

		if (dto.bcc && bcc.length === 0) errors.push({ field: 'bcc', message: 'Copia oculta inválida' });
		if (errors.length) throw validationException(errors);
		const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => b - a);

		await withApiWriter(this.dataSource, async (runner) => {
			await runner.query(
				`INSERT INTO invoice_collection_settings (holding_id, dunning_enabled, email_from, bcc, reminder_days_before, reminder_days_after,
					email_subject_template, email_body_template)
				VALUES ($1, $2, $3, $4, $5::int[], $6::int[], $7, $8)
				ON CONFLICT (holding_id) DO UPDATE SET dunning_enabled = EXCLUDED.dunning_enabled, email_from = EXCLUDED.email_from, bcc = EXCLUDED.bcc,
					reminder_days_before = EXCLUDED.reminder_days_before, reminder_days_after = EXCLUDED.reminder_days_after,
					email_subject_template = EXCLUDED.email_subject_template, email_body_template = EXCLUDED.email_body_template, updated_at = now()`,
				[
					holdingId,
					dto.dunning_enabled,
					dto.email_from ?? null,
					bcc.length ? bcc.join(', ') : null,
					sorted(dto.reminder_days_before),
					sorted(dto.reminder_days_after).reverse(),
					dto.email_subject_template,
					dto.email_body_template,
				]
			);
		});

		return await this.settings(holdingId);
	}

	// ---------------------------------------------------------------- proforma

	async proforma(holdingId: string, invoiceId: string, dto: ProformaDto, authId: string, now = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);
		const invoice = await this.read.invoiceSnapshot(holdingId, invoiceId, now);
		const blockers: BillingBlocker[] = [];

		if (!invoice.contract_id) blockers.push(noContractBlocker(invoice.invoice_number ?? invoice.id));
		if (invoice.document_kind !== 'invoice')
			blockers.push({ code: 'credit_note', message: 'Las notas de crédito no tienen proforma', next_step: null });
		if (invoice.status === 'Cancelada' || invoice.voided)
			blockers.push({ code: 'cancelled', message: 'La factura está cancelada o anulada', next_step: null });
		if (blockers.length) throw this.blocked(blockers);
		// Mismos datos que la Proforma del 360 (`invoiceDetail`): receptor, contrato, período, líneas visibles y totales.
		const detail = invoice.contract_id ? await this.contracts.invoiceDetail(invoice.contract_id, invoice.id, holdingId) : null;
		const settings = await this.settings(holdingId);
		const sender = this.sender(settings, invoice.company_name);
		const recipients = cleanEmails(dto.recipients);
		const subject =
			dto.subject ??
			`Proforma ${invoice.invoice_number ?? detail?.contract_number ?? ''} · ${invoice.company_name ?? ''}`.replace(/\s+·\s*$/, '').trim();
		const html = proformaHtml(invoice, detail, dto.message ?? null);

		await this.emails.send({
			to: recipients,
			subject,
			html,
			from: sender.from,
			fromName: sender.name,
			bcc: cleanEmails([settings.bcc]),
			attachments: dto.pdf_base64
				? [{ content: dto.pdf_base64.replace(/\s/g, ''), filename: dto.filename ?? `proforma-${invoice.invoice_number ?? invoice.id}.pdf` }]
				: undefined,
		});
		const ids = await withApiWriter(this.dataSource, async (runner) => {
			const out: string[] = [];

			for (const recipient of recipients) {
				const [row] = (await runner.query(
					`INSERT INTO invoice_emails (invoice_id, template, recipient, subject, message, sent_by, holding_id)
					VALUES ($1, 'proforma', $2, $3, $4, $5, $6) RETURNING id`,
					[invoice.id, recipient, subject, dto.message ?? null, userId, holdingId]
				)) as Row[];

				out.push(String(row.id));
			}

			return out;
		});

		return { invoice_id: invoice.id, sent: true, recipients, subject, attachment: !!dto.pdf_base64, email_ids: ids, warnings: sender.warnings };
	}

	// ---------------------------------------------------------------- correo de cobro

	async previewCollection(holdingId: string, dto: CollectionDto, now = new Date()) {
		return await this.planCollection(holdingId, dto, now);
	}

	async sendCollection(holdingId: string, dto: CollectionDto, authId: string, now = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);
		const plan = await this.planCollection(holdingId, dto, now);

		if (!plan.can_apply)
			throw this.blocked(
				plan.blockers.length ? plan.blockers : [{ code: 'nothing_to_send', message: 'No hay correos que enviar', next_step: null }],
				plan
			);
		const bulkId = randomUUID();
		const sent: Array<{ client_id: string | null; invoice_ids: string[]; recipients: string[] }> = [];
		const failed: Array<{ client_id: string | null; invoice_ids: string[]; message: string }> = [];

		for (const email of plan.emails) {
			let status = 'sent';
			let error: string | null = null;

			try {
				await this.emails.send({
					to: email.recipients,
					subject: email.subject,
					html: email.body_html,
					from: plan.sender.from,
					fromName: plan.sender.name,
					bcc: email.bcc,
				});
			} catch (caught) {
				status = 'failed';
				error = caught instanceof Error ? caught.message : String(caught);
				this.logger.warn(`Correo de cobro no enviado (holding ${holdingId}, cliente ${email.client_id ?? 'sin cliente'}): ${error}`);
			}
			await this.logCollection(holdingId, userId, email, status, todayFor(null, now), {
				kind: 'collection',
				bulk_id: bulkId,
				client_id: email.client_id,
				error,
			});
			if (status === 'sent')
				sent.push({ client_id: email.client_id, invoice_ids: email.invoices.map((invoice) => invoice.id), recipients: email.recipients });
			else
				failed.push({
					client_id: email.client_id,
					invoice_ids: email.invoices.map((invoice) => invoice.id),
					message: error ?? 'No se pudo enviar',
				});
		}

		return { bulk_id: bulkId, sent, failed, skipped: plan.skipped, warnings: plan.warnings };
	}

	private async planCollection(holdingId: string, dto: CollectionDto, now: Date) {
		const today = todayFor(null, now);
		const ids = [...new Set(dto.invoice_ids)];
		const rows = (await this.read.rowsByIds(holdingId, ids, today)).map(mapInvoiceRow);
		const settings = await this.settings(holdingId);
		const skipped: Array<{ invoice_id: string; invoice_number: string | null; reason: string; message: string }> = [];
		const blockers: BillingBlocker[] = [];
		const custom = dto.recipients_mode === 'custom' ? cleanEmails(dto.recipients ?? []) : [];

		if (dto.recipients_mode === 'custom' && custom.length === 0) {
			throw validationException([{ field: 'recipients', message: 'Indica al menos un destinatario' }]);
		}
		for (const id of ids.filter((value) => !rows.some((row) => row.id === value))) {
			skipped.push({ invoice_id: id, invoice_number: null, reason: 'not_found', message: 'Factura no encontrada en el holding' });
		}
		const eligible: InvoiceView[] = [];

		// Sin contrato: solo lectura (spec §11.1), mismo bloqueo que los pagos; la operación entera no se aplica (409).
		for (const row of rows.filter((entry) => !entry.contract_id)) blockers.push(noContractBlocker(row.invoice_number ?? row.id));
		for (const row of rows) {
			const reason = collectionSkipReason(row);

			if (reason) skipped.push({ invoice_id: row.id, invoice_number: row.invoice_number, ...reason });
			else eligible.push(row);
		}
		const contacts =
			dto.recipients_mode === 'entity_contacts'
				? await this.contactsByClient(
						holdingId,
						eligible.map((row) => row.client_id)
					)
				: new Map();
		const byClient = new Map<string, InvoiceView[]>();

		for (const row of eligible) byClient.set(row.client_id ?? 'none', [...(byClient.get(row.client_id ?? 'none') ?? []), row]);
		const sender = this.sender(settings, eligible[0]?.company_name ?? null);
		const emails: CollectionEmailPlan[] = [];

		for (const invoices of byClient.values()) {
			const clientId = invoices[0].client_id;
			const recipients = dto.recipients_mode === 'custom' ? custom : (contacts.get(clientId ?? '') ?? []);

			if (!recipients.length) {
				for (const row of invoices) {
					skipped.push({
						invoice_id: row.id,
						invoice_number: row.invoice_number,
						reason: 'no_contacts',
						message: 'El cliente no tiene contactos con correo (o no aceptan correos de cobranza)',
					});
				}
				continue;
			}
			const values = templateValues(invoices);
			const subject = renderTemplate(dto.subject ?? settings.email_subject_template, values, false);
			const body = renderTemplate(dto.message ?? settings.email_body_template, values, true);

			emails.push({
				client_id: clientId,
				client_name: invoices[0].client_name,
				recipients,
				bcc: cleanEmails([settings.bcc]),
				subject,
				body_html: `${body}${invoicesTableHtml(invoices)}`,
				invoices: invoices.map((row) => ({
					id: row.id,
					invoice_number: row.invoice_number,
					currency: row.invoice_currency,
					balance: row.balance,
					due_date: row.due_date,
					days_overdue: row.days_overdue,
				})),
			});
		}

		return {
			emails,
			skipped,
			blockers,
			warnings: sender.warnings,
			sender,
			totals_by_currency: collectionTotals(emails),
			can_apply: emails.length > 0 && blockers.length === 0,
		};
	}

	// ---------------------------------------------------------------- recordatorios automáticos (job `billing-reminders`)

	/**
	 * Un holding: emitidas con saldo cuyo vencimiento cae en `reminder_days_before` / `reminder_days_after` de hoy. Solo correo, nunca NC (solo
	 * `document_kind = invoice`), idempotente por factura + día (log `metadata.kind = reminder`, `metadata.run_date`, con candado de transacción
	 * por factura y día: dos réplicas no duplican). Requiere `dunning_enabled`.
	 */
	async runReminders(holdingId: string, now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
		const settings = await this.settings(holdingId);
		const result = { sent: 0, skipped: 0, failed: 0 };

		if (!settings.exists || !settings.dunning_enabled) return result;
		const today = todayFor(null, now);
		const page = await this.read.invoices(
			holdingId,
			{ document_kind: 'invoice', payment_state: 'unpaid,partial,overdue', limit: 200, page: 1, sortBy: 'due_date', sortOrder: 'asc' },
			now
		);
		const candidates: InvoiceView[] = [...page.data];

		for (let current = 2; current <= page.pages; current++) {
			const next = await this.read.invoices(
				holdingId,
				{
					document_kind: 'invoice',
					payment_state: 'unpaid,partial,overdue',
					limit: 200,
					page: current,
					sortBy: 'due_date',
					sortOrder: 'asc',
				},
				now
			);

			candidates.push(...next.data);
		}
		const due = candidates
			.filter((row) => row.document_kind === 'invoice' && (row.balance ?? 0) > 0)
			.map((row) => ({ row, match: reminderMatch(row.due_date, today, settings.reminder_days_before, settings.reminder_days_after) }))
			.filter((entry) => entry.match !== null);

		if (!due.length) return result;
		const contacts = await this.contactsByClient(
			holdingId,
			due.map((entry) => entry.row.client_id)
		);
		const sender = this.sender(settings, null);

		for (const { row, match } of due) {
			const recipients = contacts.get(row.client_id ?? '') ?? [];

			if (!recipients.length) {
				result.skipped += 1;
				continue;
			}
			const values = templateValues([row]);
			const email: CollectionEmailPlan = {
				client_id: row.client_id,
				client_name: row.client_name,
				recipients,
				bcc: cleanEmails([settings.bcc]),
				subject: renderTemplate(settings.email_subject_template, values, false),
				body_html: `${renderTemplate(settings.email_body_template, values, true)}${invoicesTableHtml([row])}`,
				invoices: [
					{
						id: row.id,
						invoice_number: row.invoice_number,
						currency: row.invoice_currency,
						balance: row.balance,
						due_date: row.due_date,
						days_overdue: row.days_overdue,
					},
				],
			};
			const outcome = await withApiWriter(this.dataSource, async (runner) => {
				const [lock] = (await runner.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`, [
					`billing-reminder:${row.id}:${today}`,
				])) as Row[];

				if (lock?.locked !== true) return 'skipped';
				const [already] = (await runner.query(
					`SELECT 1 FROM invoice_collection_logs WHERE invoice_id = $1 AND holding_id = $2 AND metadata->>'kind' = 'reminder' AND metadata->>'run_date' = $3 LIMIT 1`,
					[row.id, holdingId, today]
				)) as Row[];

				if (already) return 'skipped';
				let status = 'sent';
				let error: string | null = null;

				try {
					await this.emails.send({
						to: recipients,
						subject: email.subject,
						html: email.body_html,
						from: sender.from,
						fromName: row.company_name ?? sender.name,
						bcc: email.bcc,
					});
				} catch (caught) {
					status = 'failed';
					error = caught instanceof Error ? caught.message : String(caught);
				}
				await runner.query(
					`INSERT INTO invoice_collection_logs (invoice_id, holding_id, recipients, subject, message, channel, status, sent_by, metadata)
					VALUES ($1, $2, $3::text[], $4, $5, 'email', $6, NULL, $7::jsonb)`,
					[
						row.id,
						holdingId,
						recipients,
						email.subject,
						email.body_html,
						status,
						JSON.stringify({ kind: 'reminder', run_date: today, ...match, error }),
					]
				);

				return status;
			});

			if (outcome === 'sent') result.sent += 1;
			else if (outcome === 'failed') result.failed += 1;
			else result.skipped += 1;
		}

		return result;
	}

	/** Holdings con recordatorios encendidos (el job solo mira estos). */
	async reminderHoldings(): Promise<string[]> {
		const rows = (await this.dataSource.query(`SELECT holding_id FROM invoice_collection_settings WHERE dunning_enabled = true`)) as Row[];

		return rows.map((row) => String(row.holding_id));
	}

	// ---------------------------------------------------------------- infraestructura

	/** Contactos con correo por cliente (prefiere los de facturación/cobranza; respeta `contact_preferences.allow_billing_emails`). */
	private async contactsByClient(holdingId: string, clientIds: Array<string | null>): Promise<Map<string, string[]>> {
		const ids = [...new Set(clientIds.filter((id): id is string => !!id))];

		if (!ids.length) return new Map();
		const rows = (await this.dataSource.query(
			`SELECT cc.client_id, cc.email, cc.contact_type
			FROM client_contacts cc
			LEFT JOIN contact_preferences cp ON cp.contact_id = cc.id AND cp.holding_id = cc.holding_id
			WHERE cc.holding_id = $1 AND cc.client_id = ANY($2::uuid[]) AND COALESCE(TRIM(cc.email), '') <> '' AND COALESCE(cp.allow_billing_emails, true)
			ORDER BY cc.client_id, cc.name NULLS LAST, cc.email`,
			[holdingId, ids]
		)) as Row[];
		const out = new Map<string, string[]>();

		for (const id of ids) {
			const own = rows.filter((row) => String(row.client_id) === id);
			const billing = own.filter((row) => BILLING_CONTACT.test(text(row.contact_type) ?? ''));

			out.set(id, cleanEmails((billing.length ? billing : own).map((row) => text(row.email))));
		}

		return out;
	}

	private sender(settings: CollectionSettings, companyName: string | null) {
		const warnings: Array<{ code: string; message: string }> = [];
		const system = this.config.get<string>('SYSTEM_EMAIL_FROM') ?? null;
		const from = settings.email_from ?? system;

		if (!from)
			throw this.blocked([
				{
					code: 'no_sender',
					message: 'No hay remitente configurado para los correos de cobranza',
					next_step: 'Configura el remitente en Recordatorios',
				},
			]);
		if (!settings.email_from)
			warnings.push({
				code: 'system_sender',
				message: `Se envía desde el remitente del sistema (${from}); configura el del holding en Recordatorios`,
			});

		return { from, name: companyName ?? this.config.get<string>('SYSTEM_EMAIL_FROM_NAME') ?? 'Sapira', warnings };
	}

	/** Log por factura y evento por contrato; `today` = fecha de negocio (America/Santiago), no `CURRENT_DATE` del servidor (UTC). */
	private async logCollection(
		holdingId: string,
		userId: string,
		email: CollectionEmailPlan,
		status: string,
		today: string,
		metadata: Record<string, unknown>
	) {
		await withApiWriter(this.dataSource, async (runner) => {
			for (const invoice of email.invoices) {
				await runner.query(
					`INSERT INTO invoice_collection_logs (invoice_id, holding_id, recipients, subject, message, channel, status, sent_by, metadata)
					VALUES ($1, $2, $3::text[], $4, $5, 'email', $6, $7, $8::jsonb)`,
					[invoice.id, holdingId, email.recipients, email.subject, email.body_html, status, userId, JSON.stringify(metadata)]
				);
			}
			if (status !== 'sent') return;
			const contracts = (await runner.query(
				`SELECT id, contract_id, invoice_number FROM invoices WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
				[holdingId, email.invoices.map((invoice) => invoice.id)]
			)) as Row[];

			for (const row of contracts) {
				if (!row.contract_id) continue;
				await runner.query(
					`INSERT INTO contract_lifecycle_events (
						contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
					) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb)`,
					[
						row.contract_id,
						holdingId,
						PAYMENT_EVENT_TYPES.collection,
						`Correo de cobro enviado: factura ${text(row.invoice_number) ?? ''}`.trim(),
						`Correo de cobro a ${email.recipients.join(', ')}`,
						userId,
						today,
						JSON.stringify({
							source: 'billing',
							invoice_id: String(row.id),
							recipients: email.recipients,
							subject: email.subject,
							...metadata,
						}),
					]
				);
			}
		});
	}

	private blocked(blockers: BillingBlocker[], preview?: unknown): ConflictException {
		return new ConflictException({ message: blockers.map((blocker) => blocker.message).join('; '), code: 'blocked', blockers, preview });
	}
}

/** Saldo a cobrar de los correos que saldrían, por moneda de factura (nunca se suman monedas). */
export function collectionTotals(emails: CollectionEmailPlan[]): Array<{ currency: string; amount: number; invoices: number }> {
	const totals = new Map<string, { currency: string; amount: number; invoices: number }>();

	for (const invoice of emails.flatMap((email) => email.invoices)) {
		const currency = (invoice.currency ?? '—').toUpperCase();
		const entry = totals.get(currency) ?? { currency, amount: 0, invoices: 0 };

		entry.amount = Math.round((entry.amount + (invoice.balance ?? 0)) * 100) / 100;
		entry.invoices += 1;
		totals.set(currency, entry);
	}

	return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Motivo para no cobrar una factura (no es error: va en `skipped`). */
export function collectionSkipReason(row: Pick<InvoiceView, 'document_kind' | 'status' | 'payment_state' | 'voided' | 'balance'>) {
	if (row.document_kind !== 'invoice') return { reason: 'credit_note', message: 'Las notas de crédito no se cobran' };
	if (row.status === 'Por Emitir') return { reason: 'not_issued', message: 'La factura todavía no se emite' };
	if (row.status === 'Cancelada' || row.voided || row.payment_state === 'not_applicable')
		return { reason: 'cancelled', message: 'La factura está cancelada o anulada' };
	if (row.payment_state === 'paid' || !(row.balance ?? 0)) return { reason: 'paid', message: 'La factura ya está pagada' };

	return null;
}

/** Variables de la plantilla para un correo (una o varias facturas del mismo cliente; montos por moneda, nunca sumados entre monedas). */
export function templateValues(invoices: InvoiceView[]): TemplateValues {
	const byCurrency = new Map<string, number>();

	for (const row of invoices) byCurrency.set(row.invoice_currency ?? '', (byCurrency.get(row.invoice_currency ?? '') ?? 0) + (row.balance ?? 0));
	const dueDates = invoices
		.map((row) => row.due_date)
		.filter((value): value is string => !!value)
		.sort();

	return {
		invoice_number: invoices.map((row) => row.invoice_number ?? '—').join(', '),
		client_name: invoices[0]?.client_entity_name ?? invoices[0]?.client_name ?? '',
		amount_due: [...byCurrency.entries()].map(([currency, amount]) => formatAmount(Math.round(amount * 100) / 100, currency)).join(' + '),
		due_date: dueDates[0] ?? '',
		issue_date: invoices[0]?.issue_date ?? '',
		company_name: invoices[0]?.company_name ?? '',
		days_overdue: String(Math.max(0, ...invoices.map((row) => row.days_overdue))),
		currency: [...byCurrency.keys()].join(', '),
		contract_number: [...new Set(invoices.map((row) => row.contract_number).filter(Boolean))].join(', '),
	};
}

/** Tabla de facturas del correo (todo escapado). */
export function invoicesTableHtml(invoices: InvoiceView[]): string {
	const rows = invoices
		.map(
			(row) =>
				`<tr><td>${escapeHtml(row.invoice_number ?? '—')}</td><td>${escapeHtml(row.issue_date ?? '')}</td><td>${escapeHtml(row.due_date ?? '')}</td>` +
				`<td style="text-align:right">${escapeHtml(formatAmount(row.balance, row.invoice_currency))}</td></tr>`
		)
		.join('');

	return `<table style="border-collapse:collapse;margin-top:16px;font-size:13px" cellpadding="6" border="1"><thead><tr><th>Factura</th><th>Emisión</th><th>Vencimiento</th><th>Saldo</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Cuerpo de la proforma: mensaje + resumen con los datos de `invoiceDetail` (líneas visibles), todo escapado. */
export function proformaHtml(
	invoice: InvoiceView,
	detail: {
		contract_number?: string | null;
		billing_period_start?: string | null;
		billing_period_end?: string | null;
		lines?: Array<Record<string, unknown>>;
	} | null,
	message: string | null
): string {
	const currency = invoice.invoice_currency;
	const lines = (detail?.lines ?? []).filter((line) => line.is_visible !== false);
	const amount = (line: Record<string, unknown>) => {
		const value = line.subtotal_invoice_currency ?? line.subtotal_contract_currency;

		return value === null || value === undefined
			? ''
			: formatAmount(
					Number(value),
					line.subtotal_invoice_currency !== null && line.subtotal_invoice_currency !== undefined ? currency : invoice.contract_currency
				);
	};
	const rows = lines
		.map(
			(line) =>
				`<tr><td>${escapeHtml(String(line.description ?? line.product_name ?? ''))}</td><td style="text-align:right">${escapeHtml(String(line.quantity ?? ''))}</td>` +
				`<td style="text-align:right">${escapeHtml(amount(line))}</td></tr>`
		)
		.join('');
	const total = invoice.total_invoice_currency !== null ? formatAmount(invoice.total_invoice_currency, currency) : 'Se valoriza al emitir (spot)';
	const intro = message ? `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : '';

	return (
		`${intro}<h3 style="margin:16px 0 4px">${escapeHtml(invoice.status === 'Por Emitir' ? 'PROFORMA' : `Documento ${invoice.invoice_number ?? ''}`)}</h3>` +
		`<p style="margin:0">${escapeHtml(invoice.company_name ?? '')} → ${escapeHtml(invoice.client_entity_name ?? invoice.client_name ?? '')}</p>` +
		`<p style="margin:0">Contrato ${escapeHtml(detail?.contract_number ?? invoice.contract_number ?? '—')} · Período ${escapeHtml(detail?.billing_period_start ?? '')} – ${escapeHtml(detail?.billing_period_end ?? '')}</p>` +
		(rows
			? `<table style="border-collapse:collapse;margin-top:12px;font-size:13px" cellpadding="6" border="1"><thead><tr><th>Detalle</th><th>Cantidad</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table>`
			: '') +
		`<p><strong>Total: ${escapeHtml(total)}</strong></p>` +
		(invoice.status === 'Por Emitir' ? '<p style="color:#666;font-size:12px">Documento no tributario.</p>' : '')
	);
}
