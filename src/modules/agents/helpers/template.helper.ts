export function renderTemplate(template: string, variables: Record<string, any>): string {
	let result = template;

	for (const [key, value] of Object.entries(variables)) {
		const regex = new RegExp(`{{${key}}}`, 'g');
		result = result.replace(regex, String(value || ''));
	}

	return result;
}

export function validateTemplate(template: string): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	const variableRegex = /{{(\w+)}}/g;
	const matches = template.matchAll(variableRegex);

	const variables = Array.from(matches).map((m) => m[1]);
	const uniqueVars = new Set(variables);

	if (variables.length !== uniqueVars.size) {
		errors.push('Template contains duplicate variable references');
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

export function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, '').trim();
}

export function formatCurrency(amount: number, currency: string): string {
	return new Intl.NumberFormat('es-CL', {
		style: 'currency',
		currency: currency || 'CLP',
	}).format(amount);
}

export function calculateDaysOverdue(dueDate: string): number {
	const due = new Date(dueDate);
	const today = new Date();
	const diff = today.getTime() - due.getTime();
	return Math.floor(diff / (1000 * 60 * 60 * 24));
}
