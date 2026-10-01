import {
	deriveQuoteStatus,
	formatQuoteNumber,
	normalizeQuoteType,
	QUOTE_STAGE_KINDS,
	quoteNumberPattern,
	type QuoteStageKind,
	quoteStatusLateral,
	stageKindFromName,
	transitionError,
	transitionEventType,
} from './quote-status';

describe('quote-status · kind por nombre (backfill §8)', () => {
	it('mapea las etapas reales de QA/prod a su kind', () => {
		// Los tres holdings de QA: Recepcionado > Negociando > Enviada > Firmada > Perdido · Recibido > Procesando > … · Enviada > Modificada > Firmada > Perdido
		expect(['Recepcionado', 'Negociando', 'Recibido', 'Procesando', 'Modificada', 'Borrador', 'En Revisión'].map(stageKindFromName)).toEqual(
			Array(7).fill('draft')
		);
		expect(stageKindFromName('Enviada')).toBe('sent');
		expect(stageKindFromName('Firmada')).toBe('signed');
		expect(stageKindFromName('FIRMADO')).toBe('signed');
		expect(stageKindFromName('Perdido')).toBe('lost');
		expect(stageKindFromName('Rechazada')).toBe('lost');
		expect(stageKindFromName('Cerrada - Perdida')).toBe('lost');
		expect(stageKindFromName('Contrato creado')).toBe('contract_created');
		// Domi 29-09: procesadas en el flujo anterior fuera de Sapira; el contrato nació con esa cotización (SimpliRoute).
		expect(stageKindFromName('Procesada previamente')).toBe('contract_created');
		expect(stageKindFromName('procesado previamente')).toBe('contract_created');
		expect(stageKindFromName(null)).toBe('draft');
	});
});

describe('quote-status · estado mostrado', () => {
	const today = '2026-09-28';

	it('el vínculo con un contrato manda aunque el holding no tenga la etapa (Hanka)', () => {
		expect(deriveQuoteStatus({ kind: 'signed', valid_until: null, has_contract: true }, today)).toBe('contract_created');
		expect(deriveQuoteStatus({ kind: 'sent', valid_until: '2026-01-01', has_contract: true }, today)).toBe('contract_created');
		expect(deriveQuoteStatus({ kind: 'contract_created', valid_until: null, has_contract: false }, today)).toBe('contract_created');
	});

	it('vencida solo en draft/sent con valid_until pasado; sin kind cuenta como borrador', () => {
		expect(deriveQuoteStatus({ kind: 'sent', valid_until: '2026-09-27', has_contract: false }, today)).toBe('expired');
		expect(deriveQuoteStatus({ kind: 'draft', valid_until: '2026-09-27', has_contract: false }, today)).toBe('expired');
		expect(deriveQuoteStatus({ kind: 'sent', valid_until: '2026-09-28', has_contract: false }, today)).toBe('sent');
		expect(deriveQuoteStatus({ kind: 'signed', valid_until: '2026-01-01', has_contract: false }, today)).toBe('signed');
		expect(deriveQuoteStatus({ kind: 'lost', valid_until: '2026-01-01', has_contract: false }, today)).toBe('lost');
		expect(deriveQuoteStatus({ kind: null, valid_until: null, has_contract: false }, today)).toBe('draft');
		expect(deriveQuoteStatus({ kind: 'otra cosa', valid_until: null, has_contract: false }, today)).toBe('draft');
	});

	it('el lateral SQL usa el placeholder de hoy y las mismas ramas', () => {
		const sql = quoteStatusLateral('$2');

		expect(sql).toContain(`q.valid_until < $2::date THEN 'expired'`);
		expect(sql).toContain(`ct.id IS NOT NULL OR ap.contract_id IS NOT NULL OR qs.kind = 'contract_created'`);
		expect(sql).toContain(`COALESCE(qs.kind, 'draft') AS kind`);
	});
});

describe('quote-status · transiciones (§5a)', () => {
	const matrix = (from: QuoteStageKind) => Object.fromEntries(QUOTE_STAGE_KINDS.map((to) => [to, transitionError(from, to, false)]));

	it('draft ⇄ sent, draft|sent → signed|lost, signed → sent|lost, lost → draft; nada entra ni sale de contract_created', () => {
		expect(matrix('draft')).toEqual({ draft: null, sent: null, signed: null, lost: null, contract_created: 'invalid_transition' });
		expect(matrix('sent')).toEqual({ draft: null, sent: null, signed: null, lost: null, contract_created: 'invalid_transition' });
		expect(matrix('signed')).toEqual({
			draft: 'invalid_transition',
			sent: null,
			signed: 'invalid_transition',
			lost: null,
			contract_created: 'invalid_transition',
		});
		expect(matrix('lost')).toEqual({
			draft: null,
			sent: 'invalid_transition',
			signed: 'invalid_transition',
			lost: 'invalid_transition',
			contract_created: 'invalid_transition',
		});
		expect(matrix('contract_created')).toEqual(Object.fromEntries(QUOTE_STAGE_KINDS.map((to) => [to, 'invalid_transition'])));
	});

	it('con contrato vinculado nada se mueve (409 quote_has_contract antes que cualquier otra regla)', () => {
		expect(transitionError('signed', 'sent', true)).toBe('quote_has_contract');
		expect(transitionError('draft', 'sent', true)).toBe('quote_has_contract');
	});

	it('nombra el evento según el salto', () => {
		expect(transitionEventType('draft', 'sent')).toBe('SENT');
		expect(transitionEventType('sent', 'signed')).toBe('SIGNED');
		expect(transitionEventType('sent', 'lost')).toBe('LOST');
		expect(transitionEventType('signed', 'sent')).toBe('REOPENED');
		expect(transitionEventType('lost', 'draft')).toBe('REOPENED');
		expect(transitionEventType('sent', 'draft')).toBe('REOPENED');
		expect(transitionEventType('draft', 'draft')).toBe('STAGE_CHANGED');
	});
});

describe('quote-status · tipo de negocio (Q-A9) y número', () => {
	it('normaliza las 9 grafías de QA/prod a los 7 códigos', () => {
		expect(['Upselling', 'Upsell', 'upsell'].map(normalizeQuoteType)).toEqual(['upsell', 'upsell', 'upsell']);
		expect(['New Business', 'NewBusiness', 'Nuevo cliente', 'Despliegue'].map(normalizeQuoteType)).toEqual(Array(4).fill('new_business'));
		expect(normalizeQuoteType('Downselling')).toBe('downsell');
		expect(normalizeQuoteType('Cross-sell')).toBe('cross_sell');
		expect(normalizeQuoteType('Renewal')).toBe('renewal');
		expect(normalizeQuoteType('Renegociación')).toBe('renegotiation');
		expect(normalizeQuoteType('Reactivación')).toBe('reactivation');
		expect(normalizeQuoteType('')).toBeNull();
		expect(normalizeQuoteType('Otra cosa')).toBeNull();
	});

	it('correlativo COT-{año}-{NNNN} y su patrón', () => {
		expect(formatQuoteNumber(2026, 7)).toBe('COT-2026-0007');
		expect(formatQuoteNumber(2026, 12345)).toBe('COT-2026-12345');
		const pattern = new RegExp(quoteNumberPattern(2026));

		expect(pattern.test('COT-2026-0007')).toBe(true);
		expect(pattern.test('COT-2025-0007')).toBe(false);
		expect(pattern.test('006Rv00000abc')).toBe(false);
	});
});
