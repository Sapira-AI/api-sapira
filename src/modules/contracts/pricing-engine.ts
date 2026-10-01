/**
 * Motor de precios v2 (`docs/v2-rediseno/spec-pricing-v2.md` §3 y §4.1). Piezas **puras**: sin fechas de calendario, sin
 * base y sin moneda. Las usa `billing-engine.ts` (una llamada por cuota), `POST /contracts/price-preview` y el recálculo
 * de la Por Emitir al registrar consumo.
 *
 * - `validatePriceSpec`: tramos sin huecos ni solapes (§3.1) y coherencia del modelo; `errors[{ field, message }]`.
 * - `resolveQuantity`: cantidad del período (§3.7): fija, del consumo registrado, estimada o pendiente (cantidad base).
 * - `priceLine`: orden fijo **gratis → modelo/tramos → descuento del ítem → mínimo → tope** (§3), sublíneas con precisión
 *   completa, `subtotal = round2(Σ sublíneas)` y el residuo en la última sublínea de tramo (§3.6).
 * - `pricingGlosa` y `splitInvoiceLines`: presentación en la factura (§3.8): una línea con el detalle en la glosa
 *   (`invoice_line_mode = single`) o una línea por tramo/paquete/asiento más los ajustes (`per_tier`).
 */

export const PRICE_MODELS = ['standard', 'graduated', 'volume', 'package', 'seat'] as const;
export type PriceModel = (typeof PRICE_MODELS)[number];
export const PRICE_QUANTITY_TYPES = ['fixed', 'metered'] as const;
export type PriceQuantityType = (typeof PRICE_QUANTITY_TYPES)[number];
/** Presentación de la línea en la factura (§3.8): una línea con el detalle en la glosa, o una línea por tramo más ajustes. */
export const INVOICE_LINE_MODES = ['single', 'per_tier'] as const;
export type InvoiceLineMode = (typeof INVOICE_LINE_MODES)[number];
export const DEFAULT_INVOICE_LINE_MODE: InvoiceLineMode = 'single';

export interface PriceTier {
	from: number;
	/** `null` o ausente = ∞ (solo el último). */
	to?: number | null;
	per_unit_amount: number;
	/** Cargo fijo del tramo (default 0). */
	flat_amount?: number | null;
}

export interface PriceSpec {
	model: PriceModel;
	quantity_type: PriceQuantityType;
	billable_metric_id?: string | null;
	/** `standard` y `seat`: precio por unidad **del período** (no mensual). */
	unit_amount?: number | null;
	tiers?: PriceTier[] | null;
	package_size?: number | null;
	package_amount?: number | null;
	seat_minimum_quantity?: number | null;
	free_units?: number | null;
	minimum_amount?: number | null;
	cap_amount?: number | null;
	/** `single` (default) = una línea de factura con el detalle en la glosa; `per_tier` = una línea por tramo/paquete/asiento más ajustes (§3.8). */
	invoice_line_mode?: InvoiceLineMode | null;
	/** `true` = el cargo fijo del tramo se cobra aunque todo el consumo caiga en unidades gratis (§3.5, pregunta 5). Default `false`. */
	charge_flat_when_free?: boolean | null;
}

export interface ConsumptionInput {
	/** `YYYY-MM-DD` = inicio del período de servicio de la línea. */
	period_start: string;
	quantity: number;
	amount_override?: number | null;
	apply_item_discount?: boolean;
	is_estimated?: boolean;
}

export type QuantitySource = 'fixed' | 'consumption' | 'estimated' | 'pending';

export interface ResolvedQuantity {
	quantity: number;
	source: QuantitySource;
	amount_override: number | null;
	apply_item_discount: boolean;
}

/** `invoiced` solo aparece en la línea de una factura complementaria: lo ya facturado del período, en negativo (§4.4). */
export type BreakdownKind = 'free' | 'tier' | 'package' | 'seat' | 'discount' | 'minimum' | 'cap' | 'invoiced';

export interface PricedSubline {
	kind: BreakdownKind;
	tier_index?: number;
	from?: number;
	to?: number | null;
	quantity: number;
	unit_amount?: number;
	flat_amount?: number;
	amount: number;
	label: string;
	/** Solo en `per_tier` (§3.8): cantidad del período de la línea completa, para recomponerla desde sus filas. */
	period_quantity?: number;
	/** Solo en `per_tier`: posición de la fila dentro del grupo del ítem y período (0-based) y cuántas son. */
	line_index?: number;
	line_count?: number;
	/** Solo en `invoiced`: la factura emitida a la que complementa esta línea (§4.4). */
	invoice_id?: string;
	/**
	 * Solo en `discount`: descuento puntual de la factura (spec facturas §3.4), no del precio. No va en la glosa ni genera fila por tramo;
	 * lo lee `nc_discount_revenue_adjustment` para el devengo.
	 */
	one_off?: boolean;
}

export interface PricedLine {
	/** Cantidad del período (consumo o fija), la que va en `invoice_items.quantity`. */
	quantity: number;
	quantity_source: QuantitySource;
	/** Unidades tarifadas después de las gratis (en `seat`, los asientos cobrados; en `package`, las unidades tarifadas). */
	billable_quantity: number;
	subtotal: number;
	/** `round6(subtotal / quantity)`; 0 si la cantidad es 0. */
	effective_unit_price: number;
	breakdown: PricedSubline[];
	warnings: string[];
}

export interface PriceLineOptions {
	amount_override?: number | null;
	apply_item_discount?: boolean;
	quantity_source?: QuantitySource;
}

export interface PriceFieldError {
	field: string;
	message: string;
}

/** Mismo redondeo que `billing-engine.round2` (half away from zero sin error binario); local para no importar en círculo. */
const round2 = (value: number): number => {
	const sign = value < 0 ? -1 : 1;

	return (sign * Math.round(Number(`${Math.abs(value)}e2`) + Number.EPSILON)) / 100 || 0;
};
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6 || 0;
const num = (value: unknown): number => {
	const parsed = typeof value === 'string' ? Number(value) : (value as number);

	return Number.isFinite(parsed) ? parsed : 0;
};
const present = (value: unknown) => value !== null && value !== undefined && value !== '';
const isFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/** Etiqueta de un tramo ("1–500", "2.001+"). */
export const tierLabel = (tier: Pick<PriceTier, 'from' | 'to'>) => {
	const format = (value: number) => value.toLocaleString('es-CL');

	return tier.to === null || tier.to === undefined ? `${format(tier.from)}+` : `${format(tier.from)}–${format(tier.to)}`;
};

/** Precio "standard fijo": el caso de hoy; el generador no cambia para él. */
export const isStandardFixed = (price: PriceSpec | null | undefined) => !price || (price.model === 'standard' && price.quantity_type === 'fixed');

/** Ítem por consumo: cantidad medida por una métrica facturable. */
export const isMetered = (price: PriceSpec | null | undefined) => price?.quantity_type === 'metered';

// ------------------------------------------------------------------ validación (§3.1)

/** Valida tramos (§3.1) y coherencia del modelo; devuelve `errors[{ field, message }]` con rutas relativas al precio. */
export function validatePriceSpec(price: PriceSpec): PriceFieldError[] {
	const errors: PriceFieldError[] = [];
	const push = (field: string, message: string) => errors.push({ field, message });
	const nonNegative = (field: keyof PriceSpec, label: string) => {
		const value = price[field];

		if (present(value) && (!isFiniteNumber(value) || (value as number) < 0)) push(field, `${label} no puede ser negativo`);
	};

	if (!price || typeof price !== 'object') return [{ field: 'model', message: 'Elige el modelo de precio' }];
	if (!PRICE_MODELS.includes(price.model)) push('model', 'Elige el modelo de precio: fijo, por tramos, volumen, paquete o asiento');
	if (!PRICE_QUANTITY_TYPES.includes(price.quantity_type)) push('quantity_type', 'Indica si la cantidad es fija o medida');
	if (price.quantity_type === 'metered' && !present(price.billable_metric_id)) {
		push('billable_metric_id', 'Un precio por consumo necesita una métrica facturable');
	}
	if (price.quantity_type === 'fixed' && present(price.billable_metric_id)) {
		push('billable_metric_id', 'Una cantidad fija no lleva métrica facturable');
	}

	const requiresUnit = price.model === 'seat' || (price.model === 'standard' && price.quantity_type === 'metered');

	if (requiresUnit && !present(price.unit_amount)) push('unit_amount', 'Escribe el precio por unidad del período');
	nonNegative('unit_amount', 'El precio por unidad');

	if (price.model === 'graduated' || price.model === 'volume') {
		const tiers = Array.isArray(price.tiers) ? price.tiers : [];

		if (!tiers.length) push('tiers', 'Agrega al menos un tramo');
		tiers.forEach((tier, index) => {
			const field = (name: keyof PriceTier) => `tiers[${index}].${name}`;
			const previous = tiers[index - 1];
			const last = index === tiers.length - 1;

			if (!isFiniteNumber(tier.from) || tier.from < 1) push(field('from'), 'El tramo empieza en una unidad de 1 o más');
			else if (index === 0 && tier.from !== 1) push(field('from'), 'El primer tramo empieza en 1');
			else if (previous && previous.to !== null && previous.to !== undefined && tier.from !== previous.to + 1) {
				push(field('from'), `El tramo debe empezar en ${(previous.to + 1).toLocaleString('es-CL')} (sin huecos ni solapes)`);
			}
			if (last) {
				if (tier.to !== null && tier.to !== undefined) push(field('to'), 'El último tramo cierra en infinito (deja "hasta" vacío)');
			} else if (!isFiniteNumber(tier.to)) push(field('to'), 'Escribe hasta dónde llega el tramo');
			else if ((tier.to as number) < tier.from) push(field('to'), 'El fin del tramo no puede ser menor que su inicio');
			if (!isFiniteNumber(tier.per_unit_amount) || tier.per_unit_amount < 0)
				push(field('per_unit_amount'), 'El precio unitario del tramo no puede ser negativo');
			if (present(tier.flat_amount) && (!isFiniteNumber(tier.flat_amount) || tier.flat_amount < 0)) {
				push(field('flat_amount'), 'El cargo fijo del tramo no puede ser negativo');
			}
		});
	} else if (Array.isArray(price.tiers) && price.tiers.length) {
		push('tiers', 'Los tramos solo aplican a los modelos por tramos y volumen');
	}

	if (price.model === 'package') {
		if (!isFiniteNumber(price.package_size) || (price.package_size as number) <= 0)
			push('package_size', 'El paquete debe tener más de 0 unidades');
		if (!isFiniteNumber(price.package_amount) || (price.package_amount as number) <= 0)
			push('package_amount', 'El precio del paquete debe ser mayor que 0');
	}
	if (price.model === 'seat') nonNegative('seat_minimum_quantity', 'El mínimo de asientos');
	nonNegative('free_units', 'Las unidades gratis');
	nonNegative('minimum_amount', 'El mínimo comprometido');
	nonNegative('cap_amount', 'El tope máximo');
	if (isFiniteNumber(price.minimum_amount) && isFiniteNumber(price.cap_amount) && (price.cap_amount as number) < (price.minimum_amount as number)) {
		push('cap_amount', 'El tope máximo no puede ser menor que el mínimo comprometido');
	}
	if (present(price.invoice_line_mode) && !INVOICE_LINE_MODES.includes(price.invoice_line_mode as InvoiceLineMode)) {
		push('invoice_line_mode', 'Elige cómo se presenta en la factura: una línea (single) o una por tramo (per_tier)');
	}
	if (present(price.charge_flat_when_free) && typeof price.charge_flat_when_free !== 'boolean') {
		push('charge_flat_when_free', 'Indica con verdadero o falso si el cargo fijo se cobra con todo el consumo gratis');
	} else if (price.charge_flat_when_free === true && price.model !== 'graduated' && price.model !== 'volume') {
		push('charge_flat_when_free', 'El cargo fijo con todo el consumo gratis solo aplica a los modelos por tramos y volumen');
	}

	return errors;
}

// ------------------------------------------------------------------ cantidad del período (§3.7)

/**
 * Cantidad de la línea para un período: fija (la del ítem), del consumo registrado cuyo `period_start` coincide con el
 * inicio del período, estimada, o pendiente (usa la **cantidad base del ítem** con advertencia; supuesto de la spec, pregunta 3).
 */
export function resolveQuantity(
	item: { quantity: number; price?: PriceSpec | null },
	period: { start: string; end: string },
	entries: ConsumptionInput[] = []
): ResolvedQuantity {
	const base = Math.max(0, num(item.quantity));

	if (!isMetered(item.price)) return { quantity: base, source: 'fixed', amount_override: null, apply_item_discount: true };
	const entry = entries.find((candidate) => String(candidate.period_start).slice(0, 10) === period.start);

	if (!entry) return { quantity: base, source: 'pending', amount_override: null, apply_item_discount: true };

	return {
		quantity: Math.max(0, num(entry.quantity)),
		source: entry.is_estimated ? 'estimated' : 'consumption',
		amount_override: present(entry.amount_override) ? num(entry.amount_override) : null,
		apply_item_discount: entry.apply_item_discount !== false,
	};
}

// ------------------------------------------------------------------ cálculo (§3)

/**
 * Aplica gratis → modelo → descuento → mínimo → tope y redondea (§3). Pura: sin fechas ni base. `discountPct` es el
 * descuento del ítem en porcentaje (0–100). Con `amount_override` el subtotal es ese monto (menos el descuento si
 * `apply_item_discount`), sin tramos, mínimo ni tope.
 */
export function priceLine(price: PriceSpec, quantity: number, discountPct: number, options: PriceLineOptions = {}): PricedLine {
	const warnings: string[] = [];
	const qty = Math.max(0, num(quantity));
	const pct = Math.min(100, Math.max(0, num(discountPct)));
	const sublines: PricedSubline[] = [];
	const push = (subline: PricedSubline) => sublines.push(subline);
	let billable = qty;

	if (present(options.amount_override)) {
		const override = num(options.amount_override);
		const kind: BreakdownKind = price.model === 'package' ? 'package' : price.model === 'seat' ? 'seat' : 'tier';

		push({ kind, quantity: qty, amount: override, label: 'Monto informado del período' });
		if (options.apply_item_discount !== false && pct > 0 && override !== 0) {
			push({ kind: 'discount', quantity: 0, amount: -override * (pct / 100), label: `Descuento del ítem ${formatPct(pct)} %` });
		}

		return finish(sublines, qty, qty, warnings, options.quantity_source);
	}

	// 1. Unidades gratis: ocupan las primeras posiciones (del primer tramo).
	const free = Math.min(qty, Math.max(0, num(price.free_units)));

	if (free > 0) push({ kind: 'free', quantity: free, unit_amount: 0, amount: 0, label: 'Unidades gratis' });
	billable = qty - free;

	// 2. Modelo / tramos.
	switch (price.model) {
		case 'standard': {
			const unit = num(price.unit_amount);

			if (billable > 0) push({ kind: 'tier', quantity: billable, unit_amount: unit, amount: billable * unit, label: 'Por unidad' });
			break;
		}
		case 'seat': {
			const unit = num(price.unit_amount);
			const minimum = Math.max(0, num(price.seat_minimum_quantity));
			const seats = Math.max(billable, minimum);

			billable = seats;
			if (seats > 0) {
				push({
					kind: 'seat',
					quantity: seats,
					unit_amount: unit,
					amount: seats * unit,
					label: seats > qty - free ? `Asientos (mínimo ${minimum.toLocaleString('es-CL')})` : 'Asientos',
				});
			}
			break;
		}
		case 'package': {
			const size = num(price.package_size);
			const amount = num(price.package_amount);
			const packages = size > 0 && billable > 0 ? Math.ceil(billable / size - 1e-9) : 0;

			if (packages > 0) {
				push({
					kind: 'package',
					quantity: packages,
					unit_amount: amount,
					amount: packages * amount,
					label: `${packages.toLocaleString('es-CL')} paquete${packages === 1 ? '' : 's'} de ${size.toLocaleString('es-CL')}`,
				});
			}
			break;
		}
		case 'graduated': {
			(price.tiers ?? []).forEach((tier, index) => {
				const from = Math.max(num(tier.from), free + 1);
				const to = tier.to === null || tier.to === undefined ? qty : Math.min(num(tier.to), qty);
				const units = Math.max(0, to - from + 1);

				if (units <= 0) return;
				const flat = num(tier.flat_amount);

				push({
					kind: 'tier',
					tier_index: index,
					from: num(tier.from),
					to: tier.to ?? null,
					quantity: units,
					unit_amount: num(tier.per_unit_amount),
					flat_amount: flat,
					amount: units * num(tier.per_unit_amount) + flat,
					label: `Tramo ${index + 1} (${tierLabel(tier)})`,
				});
			});
			// Pregunta 5 (configurable): todo el consumo en gratis y `charge_flat_when_free` → el cargo fijo del primer tramo igual se cobra.
			if (qty > 0 && billable === 0 && price.charge_flat_when_free === true) flatOnlySubline(price.tiers?.[0], 0, push);
			break;
		}
		case 'volume': {
			// Todo al tramo alcanzado por la cantidad total del período; se tarifa la cantidad después de las gratis.
			const tiers = price.tiers ?? [];
			const index = tiers.findIndex((tier) => qty >= num(tier.from) && (tier.to === null || tier.to === undefined || qty <= num(tier.to)));
			const tier = tiers[index];

			if (tier && billable > 0) {
				const flat = num(tier.flat_amount);

				push({
					kind: 'tier',
					tier_index: index,
					from: num(tier.from),
					to: tier.to ?? null,
					quantity: billable,
					unit_amount: num(tier.per_unit_amount),
					flat_amount: flat,
					amount: billable * num(tier.per_unit_amount) + flat,
					label: `Tramo ${index + 1} (${tierLabel(tier)})`,
				});
			} else if (tier && qty > 0 && billable === 0 && price.charge_flat_when_free === true) {
				// Pregunta 5: en volumen el tramo lo fija la cantidad total; con todo gratis se cobra solo su cargo fijo.
				flatOnlySubline(tier, index, push);
			}
			break;
		}
		default:
			warnings.push(`Modelo de precio "${String(price.model)}" no soportado`);
	}

	const modelAmount = sublines.reduce((sum, subline) => sum + subline.amount, 0);

	// 3. Descuento del ítem.
	if (pct > 0 && modelAmount > 0)
		push({ kind: 'discount', quantity: 0, amount: -modelAmount * (pct / 100), label: `Descuento del ítem ${formatPct(pct)} %` });
	let running = sublines.reduce((sum, subline) => sum + subline.amount, 0);

	// 4. Mínimo comprometido (por período de la línea; supuesto, pregunta 1).
	if (present(price.minimum_amount) && running < num(price.minimum_amount)) {
		const minimum = num(price.minimum_amount);

		push({ kind: 'minimum', quantity: 0, amount: minimum - running, label: 'Ajuste por mínimo comprometido' });
		running = minimum;
	}
	// 5. Tope máximo.
	if (present(price.cap_amount) && running > num(price.cap_amount)) {
		const cap = num(price.cap_amount);

		push({ kind: 'cap', quantity: 0, amount: cap - running, label: 'Tope máximo' });
		running = cap;
	}

	return finish(sublines, qty, billable, warnings, options.quantity_source);
}

const formatPct = (pct: number) => String(round6(pct)).replace('.', ',');

/** Sublínea de tramo sin unidades tarifadas: solo el cargo fijo (`charge_flat_when_free`, §3.5). Nada si el tramo no tiene cargo fijo. */
function flatOnlySubline(tier: PriceTier | undefined, index: number, push: (subline: PricedSubline) => void) {
	const flat = num(tier?.flat_amount);

	if (!tier || flat <= 0) return;
	push({
		kind: 'tier',
		tier_index: index,
		from: num(tier.from),
		to: tier.to ?? null,
		quantity: 0,
		unit_amount: num(tier.per_unit_amount),
		flat_amount: flat,
		amount: flat,
		label: `Tramo ${index + 1} (${tierLabel(tier)}) - cargo fijo`,
	});
}

/** Redondeo §3.6: subtotal = round2(Σ sin redondear); sublíneas a 2 decimales y el residuo en la última sublínea de tramo. */
function finish(sublines: PricedSubline[], quantity: number, billable: number, warnings: string[], source?: QuantitySource): PricedLine {
	const subtotal = round2(sublines.reduce((sum, subline) => sum + subline.amount, 0));
	const rounded = sublines.map((subline) => ({ ...subline, amount: round2(subline.amount) }));
	const residue = round2(subtotal - rounded.reduce((sum, subline) => sum + subline.amount, 0));

	if (residue !== 0 && rounded.length) {
		const tierKinds = new Set<BreakdownKind>(['tier', 'package', 'seat']);
		let target = -1;

		for (let index = rounded.length - 1; index >= 0; index -= 1) {
			if (tierKinds.has(rounded[index].kind)) {
				target = index;
				break;
			}
		}
		if (target < 0) target = rounded.length - 1;
		rounded[target] = { ...rounded[target], amount: round2(rounded[target].amount + residue) };
	}

	return {
		quantity,
		quantity_source: source ?? 'fixed',
		billable_quantity: billable,
		subtotal,
		effective_unit_price: quantity > 0 ? round6(subtotal / quantity) : 0,
		breakdown: rounded,
		warnings,
	};
}

// ------------------------------------------------------------------ presentación en la factura (§3.8)

const fmtQty = (value: number) => value.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
const fmtMoney = (value: number) => value.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Separador entre la glosa base de la línea y el detalle de precio (solo ASCII, regla de la glosa del generador). */
export const GLOSA_DETAIL_SEPARATOR = ' - ';
/** Glosa apta para el DTE: sin guion largo ni signos no ASCII (misma regla que `lineDescription`). */
export const asciiGlosa = (text: string) =>
	text
		.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-')
		.replace(/\u00d7/g, 'x')
		.replace(/\s+/g, ' ')
		.trim();
const GLOSA_PREFIXES = ['Tramos:', 'Detalle:'] as const;

/**
 * Detalle compacto del desglose para la glosa de una línea `single` (§3.8): "Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00;
 * 501-1.250 x 0,06; descuento -8,70; minimo comprometido +26,60". Solo ASCII (sin guion largo ni "×") para el DTE. Vacío si no hay
 * sublíneas.
 */
export function pricingGlosa(priced: Pick<PricedLine, 'breakdown'>): string {
	const parts: string[] = [];
	let position = 1;
	let hasTiers = false;

	for (const subline of priced.breakdown) {
		// El descuento puntual de la factura no es parte del precio: no va en la glosa.
		if (subline.one_off === true) continue;
		switch (subline.kind) {
			case 'free':
				parts.push(`gratis ${fmtQty(subline.quantity)}`);
				position += subline.quantity;
				break;
			case 'tier': {
				const unit = num(subline.unit_amount);
				const flat = num(subline.flat_amount);
				const flatText = flat > 0 ? ` + fijo ${fmtMoney(flat)}` : '';

				if (subline.tier_index === undefined) {
					parts.push(`${fmtQty(subline.quantity)} x ${fmtQty(unit)}`);
				} else if (subline.quantity <= 0) {
					hasTiers = true;
					parts.push(`cargo fijo ${fmtMoney(flat)}`);
				} else {
					hasTiers = true;
					parts.push(`${fmtQty(position)}-${fmtQty(position + subline.quantity - 1)} x ${fmtQty(unit)}${flatText}`);
					position += subline.quantity;
				}
				break;
			}
			case 'package':
				parts.push(`${fmtQty(subline.quantity)} paquete${subline.quantity === 1 ? '' : 's'} x ${fmtMoney(num(subline.unit_amount))}`);
				break;
			case 'seat':
				parts.push(`${fmtQty(subline.quantity)} asiento${subline.quantity === 1 ? '' : 's'} x ${fmtQty(num(subline.unit_amount))}`);
				break;
			case 'discount':
				parts.push(`descuento ${fmtMoney(subline.amount)}`);
				break;
			case 'minimum':
				parts.push(`minimo comprometido +${fmtMoney(subline.amount)}`);
				break;
			case 'cap':
				parts.push(`tope ${fmtMoney(subline.amount)}`);
				break;
			case 'invoiced':
				parts.push(`ya facturado ${fmtMoney(subline.amount)}`);
				break;
		}
	}
	if (!parts.length) return '';

	return `${hasTiers ? GLOSA_PREFIXES[0] : GLOSA_PREFIXES[1]} ${parts.join('; ')}`;
}

/** Glosa base de una línea (sin el detalle de precio que `pricingGlosa` le agregó), para reescribirla al recalcular. */
export function baseGlosa(description: string | null | undefined): string {
	const text = (description ?? '').trim();

	for (const prefix of GLOSA_PREFIXES) {
		const index = text.indexOf(`${GLOSA_DETAIL_SEPARATOR}${prefix}`);

		if (index >= 0) return text.slice(0, index).trim();
	}

	return text;
}

/** Glosa completa de una línea `single`: base + detalle compacto (si hay desglose). */
export const describeSingleLine = (base: string, priced: Pick<PricedLine, 'breakdown'>) => {
	const detail = pricingGlosa(priced);

	return detail ? `${baseGlosa(base)}${GLOSA_DETAIL_SEPARATOR}${detail}` : baseGlosa(base);
};

/** Una fila de factura de un ítem y período en modo `per_tier` (§3.8). */
export interface InvoiceLinePart {
	/** `charge` = tramo/paquete/asiento (o la fila única cuando no hay cargos); `adjustment` = descuento, mínimo, tope o ya facturado. */
	part: 'charge' | 'adjustment';
	index: number;
	count: number;
	quantity: number;
	unit_price: number;
	subtotal: number;
	label: string;
	/** Sub-desglose de la fila: su sublínea con `period_quantity`, `line_index` y `line_count`. */
	breakdown: PricedSubline[];
}

const CHARGE_KINDS = new Set<BreakdownKind>(['tier', 'package', 'seat']);

/**
 * Filas de factura de una línea tarifada en modo `per_tier` (§3.8): una por sublínea de tramo/paquete/asiento (cantidad = unidades
 * de la sublínea, unitario = monto / unidades, con el cargo fijo incluido) y una por ajuste (descuento, mínimo, tope, ya
 * facturado) con cantidad 1 y unitario = monto (negativo o positivo). Las gratis no generan fila (van en la glosa de la
 * primera). Σ filas = `subtotal` de la línea. Sin cargos ni ajustes (todo gratis o cantidad 0): una sola fila en 0 con el
 * desglose completo.
 */
export function splitInvoiceLines(priced: PricedLine): InvoiceLinePart[] {
	// El descuento puntual de la factura (spec facturas §3.4) no genera fila por tramo (nunca líneas negativas).
	priced = { ...priced, breakdown: priced.breakdown.filter((subline) => subline.one_off !== true) };
	const charges = priced.breakdown.filter((subline) => CHARGE_KINDS.has(subline.kind) && (subline.quantity > 0 || subline.amount !== 0));
	const adjustments = priced.breakdown.filter((subline) => !CHARGE_KINDS.has(subline.kind) && subline.kind !== 'free' && subline.amount !== 0);
	const free = priced.breakdown.filter((subline) => subline.kind === 'free');
	const selected = [...charges, ...adjustments];
	const count = Math.max(1, selected.length);
	const decorate = (sublines: PricedSubline[], index: number) =>
		sublines.map((subline) => ({ ...subline, period_quantity: priced.quantity, line_index: index, line_count: count }));

	if (!selected.length) {
		return [
			{
				part: 'charge',
				index: 0,
				count: 1,
				quantity: priced.quantity,
				unit_price: 0,
				subtotal: priced.subtotal,
				label: free.length ? free[0].label : 'Sin consumo tarifado',
				breakdown: decorate(priced.breakdown, 0),
			},
		];
	}

	return selected.map((subline, index) => {
		const isCharge = CHARGE_KINDS.has(subline.kind);
		const quantity = isCharge && subline.quantity > 0 ? subline.quantity : 1;
		// Las gratis viajan en el sub-desglose de la primera fila para que la glosa las muestre.
		const own = index === 0 && free.length ? [...free, subline] : [subline];

		return {
			part: isCharge ? 'charge' : 'adjustment',
			index,
			count,
			quantity,
			unit_price: round6(subline.amount / quantity),
			subtotal: subline.amount,
			label: subline.label,
			breakdown: decorate(own, index),
		};
	});
}

/** IVA por fila a partir del IVA de la línea completa: cada fila `round2(subtotal × tasa)`, el residuo en la última fila de cargo. */
export function distributeTax(subtotals: number[], taxRate: number, charges?: boolean[]): number[] {
	const total = round2((subtotals.reduce((sum, value) => sum + value, 0) * taxRate) / 100);
	const taxes = subtotals.map((value) => round2((value * taxRate) / 100));
	const residue = round2(total - taxes.reduce((sum, value) => sum + value, 0));

	if (residue !== 0 && taxes.length) {
		let target = taxes.length - 1;

		if (charges)
			for (let index = charges.length - 1; index >= 0; index -= 1)
				if (charges[index]) {
					target = index;
					break;
				}
		taxes[target] = round2(taxes[target] + residue);
	}

	return taxes;
}
