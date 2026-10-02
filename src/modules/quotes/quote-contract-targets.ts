/**
 * Contratos destino de una cotización (`GET /quotes/:id/contract-targets`, spec modificaciones §9.2 "Desde Cotizaciones, Asociar a contrato"):
 * los contratos **Activos** del cliente de la cotización donde puede aplicarse con `POST /contracts/:id/changes` y `origin { type: 'quote' }`,
 * con la sugerencia por ítem cotizado: `item_change` (el producto ya está vivo en el contrato: upsell de cantidad/precio del ítem madre) o
 * `item_add` (producto nuevo: cross-sell, en la moneda de la cotización). Reglas puras, sin base.
 */
import { normalizeQuoteType, type QuoteDerivedStatus } from './quote-status';

export interface TargetQuote {
	id: string;
	status: QuoteDerivedStatus;
	quote_type: string | null;
	currency: string | null;
}

export interface TargetQuoteItem {
	id: string;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	quantity: number | null;
	unit_price: number | null;
	currency: string | null;
	is_recurring: boolean;
}

export interface TargetContract {
	id: string;
	contract_number: string | null;
	derived_status: string;
	contract_currency: string | null;
	requires_multicurrency_billing: boolean;
	next_item_end_date: string | null;
	mrr: number;
}

/** Ítem madre vivo del contrato (recurrente, sin baja ni renovación, no es un ajuste). */
export interface TargetContractItem {
	contract_id: string;
	id: string;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	quantity: number | null;
	unit_price: number | null;
	monthly_price: number | null;
	currency: string | null;
}

export interface ContractTarget extends TargetContract {
	can_apply: boolean;
	blockers: Array<{ code: string; message: string }>;
	warnings: Array<{ code: string; message: string }>;
	suggestions: Array<{
		quote_item_id: string;
		product_id: string | null;
		product_name: string | null;
		change_type: 'item_change' | 'item_add';
		/** `item_change`: ítem madre que se cambia (mismo producto y cuenta). */
		item_id: string | null;
		current: { quantity: number | null; unit_price: number | null; monthly_price: number | null } | null;
		proposed: { quantity: number | null; unit_price: number | null; currency: string | null };
	}>;
}

const upper = (value: string | null | undefined) => (value ?? '').trim().toUpperCase();

/**
 * Bloqueos (los mismos que aplicaría `POST /contracts/:id/changes`): cotización no firmada (`quote_not_signed`), ya aplicada o con contrato
 * (`quote_already_applied`), de nuevo negocio (`new_business_quote_on_existing_contract`, S3-3). Avisos: contrato Por renovar (no admite
 * `item_add`, solo `item_change`), moneda distinta sin multimoneda (`multicurrency_not_enabled`: el alta pedirá activarla).
 */
export function contractTargetsOf(
	quote: TargetQuote,
	quoteItems: TargetQuoteItem[],
	contracts: TargetContract[],
	items: TargetContractItem[]
): ContractTarget[] {
	const blockers: ContractTarget['blockers'] = [];

	if (quote.status === 'contract_created')
		blockers.push({ code: 'quote_already_applied', message: 'La cotización ya tiene un contrato o ya se aplicó a uno' });
	else if (quote.status !== 'signed')
		blockers.push({ code: 'quote_not_signed', message: 'Solo una cotización firmada se aplica a un contrato: márcala firmada primero' });
	if (normalizeQuoteType(quote.quote_type) === 'new_business')
		blockers.push({
			code: 'new_business_quote_on_existing_contract',
			message: 'La cotización es de nuevo negocio: crea un contrato nuevo desde ella (S3-3)',
		});

	return contracts.map((contract) => {
		const own = items.filter((item) => item.contract_id === contract.id);
		const warnings: ContractTarget['warnings'] = [];
		const suggestions: ContractTarget['suggestions'] = quoteItems.map((quoteItem) => {
			const match =
				own.find((item) => item.product_id === quoteItem.product_id && (item.account ?? '') === (quoteItem.account ?? '')) ??
				own.find((item) => item.product_id === quoteItem.product_id) ??
				null;

			return {
				quote_item_id: quoteItem.id,
				product_id: quoteItem.product_id,
				product_name: quoteItem.product_name,
				change_type: match && quoteItem.is_recurring ? 'item_change' : 'item_add',
				item_id: match && quoteItem.is_recurring ? match.id : null,
				current:
					match && quoteItem.is_recurring
						? { quantity: match.quantity, unit_price: match.unit_price, monthly_price: match.monthly_price }
						: null,
				proposed: {
					quantity: quoteItem.quantity,
					unit_price: quoteItem.unit_price,
					currency: upper(quoteItem.currency || quote.currency) || null,
				},
			};
		});
		const currency = upper(quote.currency);

		if (contract.derived_status === 'pending_renewal' && suggestions.some((entry) => entry.change_type === 'item_add'))
			warnings.push({
				code: 'pending_renewal_item_add',
				message: 'El contrato está Por renovar: renuévalo antes de agregar productos nuevos (los cambios de ítems existentes sí se aplican)',
			});
		if (currency && currency !== upper(contract.contract_currency) && !contract.requires_multicurrency_billing)
			warnings.push({
				code: 'multicurrency_not_enabled',
				message: `La cotización está en ${currency} y el contrato en ${upper(contract.contract_currency)}: al aplicarla se pedirá activar multimoneda`,
			});

		return { ...contract, can_apply: blockers.length === 0, blockers, warnings, suggestions };
	});
}
