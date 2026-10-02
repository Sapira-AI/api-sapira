import { headerFromLines } from './consumption';
import { creditNotePendingEmission, creditNoteStatusFor } from './contract-360';
import {
	commonBlockers,
	type ContractInvoiceContext,
	type ContractInvoiceLineRow,
	type ContractInvoiceRow,
	effectiveFxPolicy,
	fixedFxLines,
	INVOICE_EVENT_TYPES,
	invoiceDueDate,
	netExactFx,
	planErpReset,
	planFx,
	planMarkIssued,
	planReferences,
	planReschedule,
	planRescheduleBulk,
	planRescheduleOne,
	planSendNow,
	sameDayOfMonth,
	spotFxLines,
} from './contract-invoices';

const TODAY = '2026-09-29';

const invoice = (overrides: Partial<ContractInvoiceRow> = {}): ContractInvoiceRow => ({
	id: 'inv-1',
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-10-01',
	original_issue_date: '2026-10-01',
	scheduled_at: '2026-10-01',
	due_date: '2026-10-31',
	contract_currency: 'USD',
	invoice_currency: 'CLP',
	amount_contract_currency: 1000,
	amount_invoice_currency: null,
	vat: 190,
	total_invoice_currency: null,
	fx_contract_to_invoice: null,
	tax_rate: 19,
	fx_rate_source: null,
	fx_confirmed_at: null,
	issued_externally: false,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	sent_at: null,
	auto_invoice: false,
	requires_references: false,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	legal_name: 'Cliente SpA',
	period_start: '2026-10-01',
	period_end: '2026-10-31',
	lines_count: 2,
	lines_without_product: 0,
	references_count: 0,
	priced_base: 1000,
	...overrides,
});

const context = (overrides: Partial<ContractInvoiceContext> = {}): ContractInvoiceContext => ({
	contract_id: 'contract-1',
	contract_number: 'CTR-2026-001',
	contract_status: 'Activo',
	contract_fx_invoice_policy: 'spot',
	contract_requires_references: false,
	auto_send_to_erp: true,
	payment_terms: { kind: 'net', days: 30 },
	entity_payment_terms: { kind: 'net', days: 60 },
	company_country: 'Chile',
	has_erp_integration: true,
	has_erp_partner: true,
	has_entity: true,
	cutoff_date: null,
	today: TODAY,
	...overrides,
});

const line = (overrides: Partial<ContractInvoiceLineRow> = {}): ContractInvoiceLineRow => ({
	id: 'line-1',
	quantity: 10,
	unit_price_contract_currency: 100,
	subtotal_contract_currency: 1000,
	tax_amount_contract_currency: 190,
	total_contract_currency: 1190,
	unit_price_invoice_currency: null,
	subtotal_invoice_currency: null,
	tax_amount_invoice_currency: null,
	total_invoice_currency: null,
	created_at: '2026-09-01T00:00:00.000Z',
	...overrides,
});

const codes = (list: Array<{ code: string }>) => list.map((entry) => entry.code);

describe('contract-invoices (lógica pura, spec facturas §3.1–3.3)', () => {
	describe('bloqueos comunes', () => {
		it('emitidas, inactivas, unificadas, legacy y NC/ND no se operan desde el contrato', () => {
			expect(codes(commonBlockers(invoice()))).toEqual([]);
			expect(codes(commonBlockers(invoice({ status: 'Emitida', invoice_number: 'F-1' })))).toEqual(['not_pending']);
			expect(codes(commonBlockers(invoice({ is_active: false })))).toEqual(['not_pending']);
			expect(codes(commonBlockers(invoice({ consolidated_into_invoice_id: 'inv-9' })))).toEqual(['unified_invoice']);
			expect(codes(commonBlockers(invoice({ invoice_type: 'Unificada' })))).toEqual(['unified_invoice']);
			expect(codes(commonBlockers(invoice({ is_legacy: true })))).toEqual(['legacy_invoice']);
			expect(codes(commonBlockers(invoice({ document_type: 'NC' })))).toEqual(['credit_note']);
			expect(codes(commonBlockers(invoice({ document_type: 'ND', status: 'Emitida' })))).toEqual(['credit_note']);
		});

		it('NC creada por la API (estado de su factura, sin folio ni ERP) = pendiente de emisión electrónica; envío → credit_note_send_pending', () => {
			const pending = invoice({ document_type: 'NC', status: 'Emitida', invoice_number: null, odoo_invoice_id: null, sent_to_odoo_at: null });

			expect(creditNotePendingEmission(pending)).toBe(true);
			expect(creditNotePendingEmission(invoice({ document_type: 'NC', status: 'Por Emitir' }))).toBe(true);
			expect(creditNotePendingEmission(invoice({ document_type: 'NC', status: 'Emitida', invoice_number: 'NC-10', odoo_invoice_id: 9 }))).toBe(
				false
			);
			expect(creditNotePendingEmission(invoice({ document_type: 'NC', status: 'Cancelada' }))).toBe(false);
			expect(creditNotePendingEmission(invoice({ document_type: 'FACTURA', status: 'Emitida' }))).toBe(false);
			expect(commonBlockers(pending)[0]).toMatchObject({
				code: 'credit_note',
				message: expect.stringContaining('pendiente de emisión electrónica'),
			});
			expect(codes(planSendNow(pending, context()).blockers)).toContain('credit_note_send_pending');
			expect(codes(planSendNow(pending, context()).blockers)).not.toContain('credit_note');
			// Corrección 01-10: la NC nace siempre Emitida, aunque su factura esté Pagada, Vencida o parcialmente pagada.
			expect(creditNoteStatusFor()).toBe('Emitida');
		});

		it('los nombres de evento son los de la spec (§4) con el envío manual propio de la etapa 1', () => {
			expect(INVOICE_EVENT_TYPES).toEqual({
				send_now: 'INVOICE_SENT_MANUALLY',
				mark_issued: 'INVOICE_ISSUED_EXTERNALLY',
				reschedule: 'INVOICE_RESCHEDULED',
				fx: 'INVOICE_FX_CHANGED',
				descriptions: 'INVOICE_DESCRIPTIONS_UPDATED',
				description_template: 'CONTRACT_DESCRIPTION_TEMPLATE_CHANGED',
				references: 'INVOICE_REFERENCES_UPDATED',
				edit: 'INVOICE_EDITED',
				deviation: 'INVOICE_DEVIATION_EXPLAINED',
				erp_reset: 'INVOICE_ERP_DRAFT_RESET',
				no_charge: 'INVOICE_NO_CHARGE',
				no_charge_reverted: 'INVOICE_NO_CHARGE_REVERTED',
				reorganize: 'INVOICES_REORGANIZED',
				voided: 'INVOICE_VOIDED',
				reissued: 'INVOICE_REISSUED',
				credit_note: 'INVOICE_CREDIT_NOTE_CREATED',
				partial_billing: 'INVOICE_PARTIAL_BILLING',
				consolidated: 'INVOICE_CONSOLIDATED',
				consolidation_undone: 'INVOICE_CONSOLIDATION_UNDONE',
			});
		});
	});

	describe('planSendNow: already_sent', () => {
		it('también bloquea si solo tiene la marca de envío (sent_to_odoo_at sin id)', () => {
			const plan = planSendNow(invoice({ invoice_currency: 'USD', sent_to_odoo_at: '2026-09-20T10:00:00.000Z' }), context());

			expect(codes(plan.blockers)).toEqual(['already_sent']);
			expect(plan.blockers[0].message).toBe('Ya se envió al ERP el 2026-09-20');
		});
	});

	describe('planSendNow (enviar al ERP ahora)', () => {
		it('sin bloqueos → can_apply con el resumen para la confirmación', () => {
			const plan = planSendNow(invoice({ fx_contract_to_invoice: 950 }), context());

			expect(plan.can_apply).toBe(true);
			expect(plan.blockers).toEqual([]);
			expect(plan.summary).toMatchObject({
				legal_name: 'Cliente SpA',
				invoice_currency: 'CLP',
				fx_policy: 'fixed',
				fx_rate: 950,
				references_count: 0,
			});
		});

		it('corre los bloqueos del 360 más los del envío puntual', () => {
			const plan = planSendNow(
				invoice({
					odoo_invoice_id: 77,
					sent_to_odoo_at: '2026-09-20T10:00:00.000Z',
					lines_without_product: 2,
					tax_rate: null,
					requires_references: true,
					fx_contract_to_invoice: null,
				}),
				context({ auto_send_to_erp: false, has_erp_integration: false, has_erp_partner: false })
			);

			expect(codes(plan.blockers)).toEqual([
				'already_sent',
				'erp_send_disabled',
				'no_erp_integration',
				'no_erp_partner',
				'needs_reference',
				'item_without_product',
				'tax_rate_missing',
			]);
			expect(plan.can_apply).toBe(false);
			expect(plan.blockers.find((blocker) => blocker.code === 'item_without_product')?.message).toContain('2 líneas');
		});

		it('la política fija del CONTRATO también exige tasa (transición), y `no_erp_partner` distingue sin razón social', () => {
			const plan = planSendNow(invoice(), context({ contract_fx_invoice_policy: 'fixed', has_erp_partner: false, has_entity: false }));

			expect(codes(plan.blockers)).toEqual(['no_erp_partner', 'fixed_fx_without_rate']);
			expect(plan.blockers[0].message).toContain('no tiene razón social');
			expect(effectiveFxPolicy(invoice(), context({ contract_fx_invoice_policy: 'fixed' }))).toBe('fixed');
			expect(effectiveFxPolicy(invoice({ fx_contract_to_invoice: 900 }), context({ contract_fx_invoice_policy: 'spot' }))).toBe('fixed');
			expect(effectiveFxPolicy(invoice({ invoice_currency: 'USD' }), context({ contract_fx_invoice_policy: 'fixed' }))).toBe('same_currency');
		});

		it('la fecha pasada y el spot no bloquean: avisan (la usuaria decide)', () => {
			const plan = planSendNow(invoice({ issue_date: '2026-08-01' }), context());

			expect(plan.can_apply).toBe(true);
			expect(codes(plan.warnings)).toEqual(['past_issue_date', 'spot_fx']);
		});

		it('misma moneda: sin aviso spot ni tasa en el resumen', () => {
			const plan = planSendNow(invoice({ invoice_currency: 'USD' }), context());

			expect(codes(plan.warnings)).toEqual([]);
			expect(plan.summary.fx_rate).toBeNull();
		});
	});

	describe('planSendNow: product_without_erp_mapping (producto sin mapeo al ERP)', () => {
		it('bloquea nombrando los productos, con el paso y la acción map_product', () => {
			const plan = planSendNow(invoice({ unmapped_products: ['Soporte Premium'] }), context());
			const blocker = plan.blockers.find((entry) => entry.code === 'product_without_erp_mapping')!;

			expect(plan.can_apply).toBe(false);
			expect(blocker.message).toContain('«Soporte Premium»');
			expect(blocker.next_step).toBe('Mapea el producto en Integraciones › Odoo');
			expect(blocker.action).toBe('map_product');
		});

		it('varios productos: muestra hasta tres y "y N más"', () => {
			const plan = planSendNow(invoice({ unmapped_products: ['A', 'B', 'C', 'D', 'E'] }), context());

			expect(plan.blockers.find((entry) => entry.code === 'product_without_erp_mapping')!.message).toContain('«A», «B», «C» y 2 más');
		});

		it('solo si la factura va por el ERP; sin productos pendientes no bloquea', () => {
			expect(codes(planSendNow(invoice({ unmapped_products: ['A'] }), context({ auto_send_to_erp: false })).blockers)).not.toContain(
				'product_without_erp_mapping'
			);
			expect(codes(planSendNow(invoice({ unmapped_products: ['A'] }), context({ has_erp_integration: false })).blockers)).not.toContain(
				'product_without_erp_mapping'
			);
			expect(codes(planSendNow(invoice({ unmapped_products: [] }), context()).blockers)).toEqual([]);
		});
	});

	describe('invoiceDueDate (vencimiento por condición de pago)', () => {
		it('condición del contrato antes que la de la razón social; México sin condición = +1 mes; sin nada = +30 días', () => {
			expect(invoiceDueDate('2026-10-15', context())).toBe('2026-11-14');
			expect(invoiceDueDate('2026-10-15', context({ payment_terms: null }))).toBe('2026-12-14');
			expect(invoiceDueDate('2026-10-15', context({ payment_terms: { kind: 'day_of_next_month', day: 5 } }))).toBe('2026-11-05');
			expect(invoiceDueDate('2026-01-31', context({ payment_terms: null, entity_payment_terms: null, company_country: 'México' }))).toBe(
				'2026-02-28'
			);
			expect(invoiceDueDate('2026-10-15', context({ payment_terms: null, entity_payment_terms: null }))).toBe('2026-11-14');
		});
	});

	describe('planMarkIssued (registrar emisión externa)', () => {
		it('Por Emitir → Emitida con folio, fecha, vencimiento por condición de pago, issued_externally y RSM desde el período', () => {
			const plan = planMarkIssued(invoice({ invoice_currency: 'USD' }), context(), { invoice_number: ' 1046 ', issue_date: '2026-10-03' });

			expect(plan.can_apply).toBe(true);
			expect(plan.before).toEqual({
				status: 'Por Emitir',
				invoice_number: null,
				issue_date: '2026-10-01',
				due_date: '2026-10-31',
				fx_rate: null,
			});
			expect(plan.after).toEqual({
				status: 'Emitida',
				invoice_number: '1046',
				issue_date: '2026-10-03',
				due_date: '2026-11-02',
				fx_rate: null,
				issued_externally: true,
			});
			expect(plan.fx).toBeNull();
			expect(plan.rsm_from_month).toBe('2026-10-01');
		});

		it('multimoneda: fija → su tasa; spot → la del body; sin ninguna → bloqueo fx_rate_missing', () => {
			expect(planMarkIssued(invoice({ fx_contract_to_invoice: 950 }), context(), { invoice_number: 'A', issue_date: TODAY }).fx).toBe(950);
			expect(planMarkIssued(invoice(), context(), { invoice_number: 'A', issue_date: TODAY, fx_rate: 940 }).fx).toBe(940);
			const missing = planMarkIssued(invoice(), context(), { invoice_number: 'A', issue_date: TODAY });

			expect(codes(missing.blockers)).toEqual(['fx_rate_missing']);
		});

		it('borrador en el ERP y período cerrado bloquean; auto-envío al ERP y fecha futura solo avisan; RSM desde el mes más temprano', () => {
			const blocked = planMarkIssued(invoice({ odoo_invoice_id: 5, invoice_currency: 'USD' }), context({ cutoff_date: '2026-09-30' }), {
				invoice_number: 'A',
				issue_date: '2026-09-15',
			});

			expect(codes(blocked.blockers)).toEqual(['sent_to_erp_draft', 'period_closed']);
			const soft = planMarkIssued(invoice({ invoice_currency: 'USD', period_start: '2026-11-01' }), context(), {
				invoice_number: 'A',
				issue_date: '2026-10-05',
			});

			expect(codes(soft.warnings)).toEqual(['erp_auto_send', 'future_issue_date']);
			expect(soft.rsm_from_month).toBe('2026-10-01');
			expect(
				codes(
					planMarkIssued(invoice({ invoice_currency: 'USD' }), context({ auto_send_to_erp: false }), {
						invoice_number: 'A',
						issue_date: TODAY,
					}).warnings
				)
			).toEqual([]);
		});
	});

	describe('planMarkIssued: solo registra (decisión de Domi 01-10)', () => {
		const valued = [line({ subtotal_invoice_currency: 950000, tax_amount_invoice_currency: 180500, total_invoice_currency: 1130500 })];

		it('spot (montos en moneda de factura NULL): valoriza líneas y encabezado con la tasa informada', () => {
			const plan = planMarkIssued(invoice(), context(), { invoice_number: 'A', issue_date: TODAY, fx_rate: 940 }, [line()]);

			expect(plan.valuate).toBe(true);
			expect(plan.fx).toBe(940);
			expect(plan.lines[0].after).toEqual({
				unit_price_invoice_currency: 94000,
				subtotal_invoice_currency: 940000,
				tax_amount_invoice_currency: 178600,
				total_invoice_currency: 1118600,
			});
			expect(plan.header).toEqual({
				amount_contract_currency: 1000,
				vat: 178600,
				amount_invoice_currency: 940000,
				total_invoice_currency: 1118600,
			});
		});

		it('ya valorizada (fija, neto exacto, OC): no reescribe nada; tasa distinta → aviso fx_mismatch', () => {
			const fixed = invoice({
				fx_contract_to_invoice: 950,
				amount_invoice_currency: 950000,
				total_invoice_currency: 1130500,
				internal_lines: 1,
			});
			const plan = planMarkIssued(
				fixed,
				context({ auto_send_to_erp: false }),
				{ invoice_number: 'A', issue_date: TODAY, fx_rate: 940 },
				valued
			);

			expect(plan.can_apply).toBe(true);
			expect(plan.valuate).toBe(false);
			expect(plan.fx).toBeNull();
			expect(plan.lines).toEqual([]);
			expect(codes(plan.warnings)).toEqual(['fx_mismatch']);
			expect(plan.warnings[0].message).toContain('ajusta la factura antes con las opciones disponibles');
			expect(plan.after.fx_rate).toBe(950);
			expect(plan.header).toEqual({
				amount_contract_currency: 1000,
				vat: 180500,
				amount_invoice_currency: 950000,
				total_invoice_currency: 1130500,
			});
			expect(
				codes(
					planMarkIssued(fixed, context({ auto_send_to_erp: false }), { invoice_number: 'A', issue_date: TODAY, fx_rate: 950 }, valued)
						.warnings
				)
			).toEqual([]);
		});
	});

	describe('planReschedule (reprogramar)', () => {
		it('escribe scheduled_at = issue_date, conserva original_issue_date y recalcula el vencimiento; no toca el período', () => {
			const plan = planRescheduleOne(invoice({ original_issue_date: '2026-09-01', issue_date: '2026-10-01' }), context(), '2026-11-10');

			expect(plan.blockers).toEqual([]);
			expect(plan.before).toEqual({
				issue_date: '2026-10-01',
				scheduled_at: '2026-10-01',
				due_date: '2026-10-31',
				original_issue_date: '2026-09-01',
			});
			expect(plan.after).toEqual({
				issue_date: '2026-11-10',
				scheduled_at: '2026-11-10',
				due_date: '2026-12-10',
				original_issue_date: '2026-09-01',
			});
			expect(codes(plan.warnings)).toEqual(['outside_current_month']);
			expect(plan.rsm_from_month).toBeNull();
		});

		it('con descuento puntual (nc_revenue_treatment) el devengo se reconstruye desde el menor mes de emisión (antes/después)', () => {
			const withOneOff = invoice({ issue_date: '2026-10-01', nc_revenue_treatment: 'impact_month' });

			expect(planRescheduleOne(withOneOff, context(), '2026-12-15').rsm_from_month).toBe('2026-10-01');
			expect(planRescheduleOne(withOneOff, context(), '2026-09-30').rsm_from_month).toBe('2026-09-01');
		});

		it('si la factura no tenía fecha original, la fija con la fecha que tenía antes de moverla', () => {
			const plan = planRescheduleOne(invoice({ original_issue_date: null }), context(), '2026-10-15');

			expect(plan.after.original_issue_date).toBe('2026-10-01');
		});

		it('fecha pasada avisa (el scheduler no la tomará); misma fecha avisa; período cerrado y borrador ERP bloquean', () => {
			expect(codes(planRescheduleOne(invoice(), context(), '2026-09-01').warnings)).toEqual(['past_issue_date']);
			expect(codes(planRescheduleOne(invoice(), context(), '2026-10-01').warnings)).toEqual(['same_date', 'outside_current_month']);
			expect(codes(planRescheduleOne(invoice({ odoo_invoice_id: 3 }), context({ cutoff_date: '2026-09-30' }), '2026-09-10').blockers)).toEqual([
				'sent_to_erp_draft',
				'period_closed',
			]);
			expect(codes(planRescheduleOne(invoice({ status: 'Emitida' }), context(), '2026-10-10').blockers)).toEqual(['not_pending']);
		});

		it('this_and_following lleva las posteriores al mismo día del mes elegido y deja fuera las anteriores y la propia', () => {
			const target = invoice({ id: 'inv-10', issue_date: '2026-10-01' });
			const following = [
				invoice({ id: 'inv-09', issue_date: '2026-09-01' }),
				target,
				invoice({ id: 'inv-11', issue_date: '2026-11-01', original_issue_date: '2026-11-01' }),
				invoice({ id: 'inv-12', issue_date: '2026-12-01', status: 'Emitida' }),
			];
			const plans = planReschedule(target, following, context(), '2026-10-06', 'this_and_following');

			expect(plans.map((plan) => [plan.id, plan.after.issue_date, codes(plan.blockers)])).toEqual([
				['inv-10', '2026-10-06', []],
				['inv-11', '2026-11-06', []],
				['inv-12', '2026-12-06', ['not_pending']],
			]);
			expect(plans[1].after.original_issue_date).toBe('2026-11-01');
			expect(planReschedule(target, following, context(), '2026-10-06', 'this')).toHaveLength(1);
			expect(planReschedule(target, following, context(), '2026-10-01', 'this_and_following')).toHaveLength(1);
		});

		it('this_and_following recorta al fin de mes y, si la fecha nueva cae en otro mes, corre esos meses', () => {
			const target = invoice({ id: 'oct', issue_date: '2026-10-29' });
			const following = [target, invoice({ id: 'nov', issue_date: '2026-11-29' }), invoice({ id: 'ene', issue_date: '2027-01-29' })];

			expect(planReschedule(target, following, context(), '2026-10-31', 'this_and_following').map((plan) => plan.after.issue_date)).toEqual([
				'2026-10-31',
				'2026-11-30',
				'2027-01-31',
			]);
			expect(planReschedule(target, following, context(), '2026-11-05', 'this_and_following').map((plan) => plan.after.issue_date)).toEqual([
				'2026-11-05',
				'2026-12-05',
				'2027-02-05',
			]);
			expect(sameDayOfMonth('2027-01-29', 1, 31)).toBe('2027-02-28');
			expect(sameDayOfMonth('2026-12-15', 1, 15)).toBe('2027-01-15');
		});

		it('masivo: corre N meses (fin de mes se recorta) o lleva todas a una fecha', () => {
			const invoices = [invoice({ id: 'a', issue_date: '2026-10-31' }), invoice({ id: 'b', issue_date: '2026-12-15' })];

			expect(planRescheduleBulk(invoices, context(), { shift_months: 1 }).map((plan) => plan.after.issue_date)).toEqual([
				'2026-11-30',
				'2027-01-15',
			]);
			expect(planRescheduleBulk(invoices, context(), { shift_months: 3 }).map((plan) => plan.after.issue_date)).toEqual([
				'2027-01-31',
				'2027-03-15',
			]);
			expect(planRescheduleBulk(invoices, context(), { issue_date: '2026-11-05' }).map((plan) => plan.after.issue_date)).toEqual([
				'2026-11-05',
				'2026-11-05',
			]);
			expect(
				codes(planRescheduleBulk([invoice({ issue_date: null, scheduled_at: null })], context(), { shift_months: 1 })[0].blockers)
			).toEqual(['no_issue_date']);
		});
	});

	describe('planFx (tipo de cambio por factura)', () => {
		const lines = [
			line(),
			line({
				id: 'line-2',
				quantity: 3,
				unit_price_contract_currency: 33.33,
				subtotal_contract_currency: 99.99,
				tax_amount_contract_currency: 19,
				total_contract_currency: 118.99,
			}),
		];

		it('fixed: tasa manual, líneas × tasa (unitario a 6, resto a 2) y encabezado con IVA en moneda de factura (B2)', () => {
			const plan = planFx(invoice(), lines, context(), { policy: 'fixed', rate: 950.123456 });

			expect(plan.blockers).toEqual([]);
			expect(plan.after).toMatchObject({
				fx_policy: 'fixed',
				fx_rate: 950.123456,
				fx_rate_source: 'manual',
				fx_contract_to_invoice: 950.123456,
			});
			expect(plan.after.amount_contract_currency).toBe(1099.99);
			// Encabezado = Σ líneas (convención única); el residuo de convertir va a la línea mayor, así Σ = conversión exacta del total.
			expect(plan.after.amount_invoice_currency).toBe(Math.round(1099.99 * 950.123456 * 100) / 100);
			expect(plan.after.vat).toBe(Math.round(209 * 950.123456 * 100) / 100);
			expect(plan.after.amount_invoice_currency).toBe(
				Math.round(plan.lines.reduce((sum, entry) => sum + entry.after.subtotal_invoice_currency!, 0) * 100) / 100
			);
			expect(plan.lines[0].after).toEqual({
				unit_price_invoice_currency: 95012.3456,
				subtotal_invoice_currency: 950123.46,
				// IVA: 190 × tasa = 180523.4566 → 180523.46, menos el centavo residual del total de IVA (209 × tasa) que absorbe la línea mayor.
				tax_amount_invoice_currency: 180523.45,
				total_invoice_currency: 1130646.91,
			});
			expect(plan.write).toMatchObject({ fx: 950.123456, fx_rate_source: 'manual' });
		});

		it('fixed sin tasa → bloqueo fixed_fx_without_rate (nunca fijo sin tasa, B3)', () => {
			expect(codes(planFx(invoice(), lines, context(), { policy: 'fixed' }).blockers)).toEqual(['fixed_fx_without_rate']);
			expect(codes(planFx(invoice(), lines, context(), { policy: 'fixed', rate: 0 }).blockers)).toEqual(['fixed_fx_without_rate']);
		});

		it('spot: montos en moneda de factura NULL hasta emitir, tasa pegada borrada, IVA del encabezado en moneda de contrato', () => {
			const plan = planFx(invoice({ fx_contract_to_invoice: 900, amount_invoice_currency: 989991 }), lines, context(), { policy: 'spot' });

			expect(plan.blockers).toEqual([]);
			expect(plan.after).toEqual({
				fx_policy: 'spot',
				fx_rate: null,
				fx_rate_source: null,
				fx_contract_to_invoice: null,
				amount_contract_currency: 1099.99,
				vat: 209,
				amount_invoice_currency: null,
				total_invoice_currency: null,
			});
			expect(plan.lines.every((entry) => Object.values(entry.after).every((value) => value === null))).toBe(true);
			expect(plan.write).toEqual({
				fx: null,
				fx_rate_source: null,
				header: { amount_contract_currency: 1099.99, vat: 209, amount_invoice_currency: null, total_invoice_currency: null },
			});
			expect(codes(planFx(invoice(), lines, context(), { policy: 'spot' }).warnings)).toEqual(['no_change']);
		});

		it('net_exact: misma matemática que apply_fixed_fx_to_contract (fx = neto ÷ Σ qty × unitario, redondeo a la línea mayor, unitario sin redondear)', () => {
			const plan = planFx(invoice(), lines, context(), { policy: 'net_exact', target_net_amount: 1000000 });
			const base = 10 * 100 + 3 * 33.33;

			expect(plan.blockers).toEqual([]);
			expect(plan.after.fx_rate).toBe(Math.round((1000000 / base) * 1e6) / 1e6);
			expect(plan.after).toMatchObject({
				fx_policy: 'fixed',
				fx_rate_source: 'net_exact',
				amount_invoice_currency: 1000000,
				vat: 190000,
				total_invoice_currency: 1190000,
			});
			const subtotals = plan.lines.map((entry) => entry.after.subtotal_invoice_currency!);

			expect(Math.round(subtotals.reduce((sum, value) => sum + value, 0) * 100) / 100).toBe(1000000);
			expect(plan.lines[0].after.unit_price_invoice_currency).toBe(subtotals[0] / 10);
			expect(plan.lines[0].after.tax_amount_invoice_currency).toBe(Math.round(subtotals[0] * 0.19 * 100) / 100);
			expect(plan.write?.fx_rate_source).toBe('net_exact');
		});

		it('net_exact ajusta la diferencia de redondeo en la línea de mayor subtotal', () => {
			const three = [
				line({ id: 'a', quantity: 1, unit_price_contract_currency: 1 }),
				line({ id: 'b', quantity: 1, unit_price_contract_currency: 1 }),
				line({ id: 'c', quantity: 1, unit_price_contract_currency: 1 }),
			];
			const result = netExactFx(three, 19, 100)!;

			// 100 / 3 = 33.33 por línea → 99.99; el centavo faltante va a la primera de las mayores (empate: la primera).
			expect(result.lines.map((entry) => entry.after.subtotal_invoice_currency)).toEqual([33.34, 33.33, 33.33]);
			expect(result.header.amount_invoice_currency).toBe(100);
			expect(netExactFx([line({ quantity: 0, unit_price_contract_currency: 0 })], 19, 100)).toBeNull();
			expect(netExactFx(three, 19, 0)).toBeNull();
		});

		it('net_exact sin base o sin neto → bloqueo no_priced_lines; tasa muy distinta de la fija actual avisa', () => {
			expect(
				codes(
					planFx(invoice(), [line({ quantity: 0, unit_price_contract_currency: 0 })], context(), {
						policy: 'net_exact',
						target_net_amount: 100,
					}).blockers
				)
			).toEqual(['no_priced_lines']);
			const plan = planFx(invoice({ fx_contract_to_invoice: 500 }), lines, context(), { policy: 'net_exact', target_net_amount: 1000000 });

			expect(codes(plan.warnings)).toEqual(['rate_far_from_current']);
		});

		it('bloqueos propios: misma moneda, UF como moneda de factura, borrador en el ERP; sin líneas ni matemática cuando bloquea', () => {
			expect(codes(planFx(invoice({ invoice_currency: 'USD' }), lines, context(), { policy: 'fixed', rate: 1 }).blockers)).toEqual([
				'same_currency',
			]);
			expect(codes(planFx(invoice({ invoice_currency: 'CLF' }), lines, context(), { policy: 'spot' }).blockers)).toEqual([
				'uf_invoice_currency',
			]);
			const blocked = planFx(invoice({ odoo_invoice_id: 9 }), lines, context(), { policy: 'fixed', rate: 900 });

			expect(codes(blocked.blockers)).toEqual(['sent_to_erp_draft']);
			expect(blocked.lines).toEqual([]);
			expect(blocked.write).toBeNull();
			expect(blocked.after).toEqual(blocked.before);
		});

		it('sin tasa de IVA avisa; el IVA del encabezado es Σ del IVA de las líneas', () => {
			const plan = planFx(invoice({ tax_rate: null }), [line()], context(), { policy: 'fixed', rate: 2 });

			expect(codes(plan.warnings)).toEqual(['tax_rate_missing']);
			expect(plan.after.vat).toBe(380);
			expect(plan.after.total_invoice_currency).toBe(2380);
		});

		it('período cerrado en la fecha de emisión bloquea el cambio de tasa', () => {
			expect(codes(planFx(invoice(), lines, context({ cutoff_date: '2026-10-31' }), { policy: 'fixed', rate: 900 }).blockers)).toEqual([
				'period_closed',
			]);
		});

		it('fixedFxLines: los centavos residuales de convertir van a la línea mayor (Σ líneas = total × tasa)', () => {
			const three = [
				line({ id: 'a', subtotal_contract_currency: 0.05, tax_amount_contract_currency: 0.01 }),
				line({ id: 'b', subtotal_contract_currency: 0.05, tax_amount_contract_currency: 0.01 }),
				line({ id: 'c', subtotal_contract_currency: 0.1, tax_amount_contract_currency: 0.02 }),
			];
			const result = fixedFxLines(three, 3.333);
			const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

			expect(sum(result.map((entry) => entry.after.subtotal_invoice_currency!))).toBe(Math.round(0.2 * 3.333 * 100) / 100);
			expect(result[2].after.subtotal_invoice_currency).toBe(0.33);
			expect(
				result.every(
					(entry) =>
						entry.after.total_invoice_currency ===
						Math.round((entry.after.subtotal_invoice_currency! + entry.after.tax_amount_invoice_currency!) * 100) / 100
				)
			).toBe(true);
		});

		it('net_exact usa el unitario efectivo (subtotal ÷ cantidad): el descuento de la línea se conserva', () => {
			// Línea con 50 % de descuento: unitario de lista 100, subtotal 500 → efectivo 50. Otra sin descuento por 500.
			const discounted = [
				line({ id: 'a', quantity: 10, unit_price_contract_currency: 100, subtotal_contract_currency: 500, tax_amount_contract_currency: 95 }),
				line({ id: 'b', quantity: 5, unit_price_contract_currency: 100, subtotal_contract_currency: 500, tax_amount_contract_currency: 95 }),
			];
			const result = netExactFx(discounted, 19, 1000)!;

			expect(result.fx).toBe(1);
			expect(result.lines.map((entry) => entry.after.subtotal_invoice_currency)).toEqual([500, 500]);
			expect(result.header).toEqual({ amount_contract_currency: 1000, vat: 190, amount_invoice_currency: 1000, total_invoice_currency: 1190 });
		});

		it('helpers de líneas: fija multiplica, spot anula', () => {
			expect(fixedFxLines([line()], 2)[0].after).toEqual({
				unit_price_invoice_currency: 200,
				subtotal_invoice_currency: 2000,
				tax_amount_invoice_currency: 380,
				total_invoice_currency: 2380,
			});
			expect(spotFxLines([line({ subtotal_invoice_currency: 5 })])[0]).toEqual({
				id: 'line-1',
				before: {
					unit_price_invoice_currency: null,
					subtotal_invoice_currency: 5,
					tax_amount_invoice_currency: null,
					total_invoice_currency: null,
				},
				after: {
					unit_price_invoice_currency: null,
					subtotal_invoice_currency: null,
					tax_amount_invoice_currency: null,
					total_invoice_currency: null,
				},
			});
		});
	});

	describe('planReferences (referencias OC/HES por factura, §3.7a)', () => {
		const codes = (items: Array<{ code: string }>) => items.map((item) => item.code);

		it('mapea OC → 801 y HES → HES con su nombre por defecto; OTHER usa su código; conserva reference_code/reason de la fila previa', () => {
			const plan = planReferences(
				invoice(),
				[
					{ type: 'OC', code: ' 4500123 ', date: '2026-09-15' },
					{ type: 'HES', code: '998', name: 'HES septiembre' },
					{ type: 'OTHER', code: 'CT-7', document_type_code: '803', name: 'Contrato' },
				],
				[
					{
						document_type_code: '801',
						document_type_name: 'Orden de Compra',
						document_number: '4500123',
						reference_date: null,
						reference_code: '',
						reason: 'OC anual',
					},
				]
			);

			expect(plan.can_apply).toBe(true);
			expect(plan.rows).toEqual([
				{
					document_type_code: '801',
					document_type_name: 'Orden de Compra',
					document_number: '4500123',
					reference_date: '2026-09-15',
					reference_code: '',
					reason: 'OC anual',
				},
				{
					document_type_code: 'HES',
					document_type_name: 'HES septiembre',
					document_number: '998',
					reference_date: null,
					reference_code: null,
					reason: null,
				},
				{
					document_type_code: '803',
					document_type_name: 'Contrato',
					document_number: 'CT-7',
					reference_date: null,
					reference_code: null,
					reason: null,
				},
			]);
		});

		it('repetidas (mismo tipo y número) → índices en duplicates y no aplica', () => {
			const plan = planReferences(
				invoice(),
				[
					{ type: 'OC', code: '1' },
					{ type: 'OC', code: '1 ' },
				],
				[]
			);

			expect(plan.duplicates).toEqual([1]);
			expect(plan.can_apply).toBe(false);
		});

		it('Por Emitir con borrador en el ERP: aplica con aviso; emitida sin ERP: aplica; emitida enviada: sent_to_erp', () => {
			expect(codes(planReferences(invoice({ odoo_invoice_id: 55 }), [], []).warnings)).toEqual(['sent_to_erp_draft']);
			expect(planReferences(invoice({ odoo_invoice_id: 55 }), [], []).can_apply).toBe(true);
			expect(planReferences(invoice({ status: 'Emitida', invoice_number: 'F-1' }), [], []).can_apply).toBe(true);
			expect(codes(planReferences(invoice({ status: 'Emitida', odoo_invoice_id: 9 }), [], []).blockers)).toEqual(['sent_to_erp']);
			expect(codes(planReferences(invoice({ status: 'Pagada', sent_to_odoo_at: '2026-09-01T00:00:00Z' }), [], []).blockers)).toEqual([
				'sent_to_erp',
			]);
		});

		it('bloquea NC/ND, canceladas o inactivas, unificadas y legacy', () => {
			expect(codes(planReferences(invoice({ document_type: 'NC' }), [], []).blockers)).toEqual(['credit_note']);
			expect(codes(planReferences(invoice({ status: 'Cancelada' }), [], []).blockers)).toEqual(['not_editable']);
			expect(codes(planReferences(invoice({ is_active: false }), [], []).blockers)).toEqual(['not_editable']);
			expect(codes(planReferences(invoice({ invoice_type: 'Unificada' }), [], []).blockers)).toEqual(['unified_invoice']);
			expect(codes(planReferences(invoice({ is_legacy: true }), [], []).blockers)).toEqual(['legacy_invoice']);
		});
	});
	describe('planErpReset (restablecer el borrador del ERP)', () => {
		it('Por Emitir vinculada al ERP: deja odoo_invoice_id, sent_to_odoo_at y sent_at en NULL y avisa que el borrador sigue en el ERP', () => {
			const plan = planErpReset(
				invoice({ odoo_invoice_id: 55, sent_to_odoo_at: '2026-09-20T10:00:00.000Z', sent_at: '2026-09-20T10:00:00.000Z' }),
				context()
			);

			expect(plan.blockers).toEqual([]);
			expect(plan.before).toMatchObject({
				odoo_invoice_id: 55,
				sent_to_odoo_at: '2026-09-20T10:00:00.000Z',
				sent_at: '2026-09-20T10:00:00.000Z',
			});
			expect(plan.after).toMatchObject({ odoo_invoice_id: null, sent_to_odoo_at: null, sent_at: null });
			expect(plan.spot_reset).toBe(false);
			expect(plan.warnings).toEqual([
				{ code: 'erp_draft_remains', message: 'El borrador sigue en el ERP: elimínalo allí para que no quede duplicado al reenviar.' },
			]);
			// Solo la marca de envío (sin id) también cuenta como vinculada, como en la función vieja.
			expect(planErpReset(invoice({ sent_to_odoo_at: '2026-09-20T10:00:00.000Z' }), context()).blockers).toEqual([]);
		});

		it('contrato spot con la tasa escrita por el envío: vuelve a spot (tasa, montos en moneda de factura y origen en NULL)', () => {
			const sent = invoice({
				odoo_invoice_id: 55,
				sent_to_odoo_at: '2026-09-20T10:00:00.000Z',
				fx_contract_to_invoice: 950,
				amount_invoice_currency: 950000,
				vat: 180500,
				total_invoice_currency: 1130500,
			});
			const plan = planErpReset(sent, context(), [line({ subtotal_invoice_currency: 950000, tax_amount_invoice_currency: 180500 })]);

			expect(plan.spot_reset).toBe(true);
			expect(plan.before).toMatchObject({ fx_contract_to_invoice: 950, amount_invoice_currency: 950000, vat: 180500 });
			expect(plan.after).toMatchObject({
				fx_contract_to_invoice: null,
				fx_rate_source: null,
				amount_invoice_currency: null,
				total_invoice_currency: null,
				vat: 190,
			});
			// Tasa fijada explícitamente (manual / neto exacto), contrato fijo o factura por OC: se conserva.
			expect(planErpReset({ ...sent, fx_explicit: true }, context()).spot_reset).toBe(false);
			expect(planErpReset(sent, context({ contract_fx_invoice_policy: 'fixed' })).spot_reset).toBe(false);
			expect(planErpReset({ ...sent, internal_lines: 2 }, context()).spot_reset).toBe(false);
		});

		it('bloqueos: no vinculada, no Por Emitir, unificada, legacy, NC y período cerrado', () => {
			expect(codes(planErpReset(invoice(), context()).blockers)).toEqual(['not_sent_to_erp']);
			expect(codes(planErpReset(invoice({ status: 'Emitida', odoo_invoice_id: 5 }), context()).blockers)).toEqual(['not_pending']);
			expect(codes(planErpReset(invoice({ invoice_type: 'Unificada', odoo_invoice_id: 5 }), context()).blockers)).toEqual(['unified_invoice']);
			expect(codes(planErpReset(invoice({ is_legacy: true, odoo_invoice_id: 5 }), context()).blockers)).toEqual(['legacy_invoice']);
			expect(codes(planErpReset(invoice({ document_type: 'NC', odoo_invoice_id: 5 }), context()).blockers)).toEqual(['credit_note']);
			expect(codes(planErpReset(invoice({ odoo_invoice_id: 5 }), context({ cutoff_date: '2026-10-31' })).blockers)).toEqual(['period_closed']);
		});

		it('el bloqueo sent_to_erp_draft de las demás operaciones ofrece la acción erp_reset', () => {
			const blocked = planMarkIssued(invoice({ odoo_invoice_id: 9 }), context(), { invoice_number: 'F-1', issue_date: '2026-10-02' });

			expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' }));
		});
	});

	describe('headerFromLines (convención única del encabezado)', () => {
		const rows = [
			line({ subtotal_invoice_currency: 950123.46, tax_amount_invoice_currency: 180523.45 }),
			line({
				id: 'line-2',
				subtotal_contract_currency: 99.99,
				tax_amount_contract_currency: 19,
				subtotal_invoice_currency: 95002.84,
				tax_amount_invoice_currency: 18052.35,
			}),
		];

		it('tasa fija: Σ de los montos YA redondeados de las líneas en moneda de factura; total = monto + IVA', () => {
			expect(headerFromLines(rows, { sameCurrency: false, fx: 950.123456, taxRate: 19 })).toEqual({
				amount_contract_currency: 1099.99,
				vat: 198575.8,
				amount_invoice_currency: 1045126.3,
				total_invoice_currency: 1243702.1,
			});
		});

		it('spot: moneda de factura NULL y vat en moneda de contrato; misma moneda: iguales a contrato', () => {
			expect(headerFromLines(rows, { sameCurrency: false, fx: null, taxRate: 19 })).toEqual({
				amount_contract_currency: 1099.99,
				vat: 209,
				amount_invoice_currency: null,
				total_invoice_currency: null,
			});
			expect(headerFromLines(rows, { sameCurrency: true, fx: 1, taxRate: 19 })).toEqual({
				amount_contract_currency: 1099.99,
				vat: 209,
				amount_invoice_currency: 1099.99,
				total_invoice_currency: 1308.99,
			});
		});

		it('acepta los nombres de LineState (tax_*) y valoriza a la tasa una línea aún sin montos en moneda de factura', () => {
			expect(
				headerFromLines(
					[
						{ subtotal_contract_currency: 100, tax_contract_currency: 19, subtotal_invoice_currency: 95000, tax_invoice_currency: 18050 },
						{ subtotal_contract_currency: 10, tax_contract_currency: 1.9, subtotal_invoice_currency: null, tax_invoice_currency: null },
					],
					{ sameCurrency: false, fx: 950, taxRate: 19 }
				)
			).toEqual({ amount_contract_currency: 110, vat: 19855, amount_invoice_currency: 104500, total_invoice_currency: 124355 });
		});
	});
});
