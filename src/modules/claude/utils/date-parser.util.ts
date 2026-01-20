export function monthStartStr(d: Date): string {
	return `${d.toISOString().slice(0, 7)}-01`;
}

export function parseMonthRange(question: string): {
	fromMonth: string;
	toMonth: string;
	monthsBack: number;
} {
	const q = question.toLowerCase();
	const today = new Date();

	const patterns = [
		{ regex: /últimos?\s+(\d+)\s+mes(?:es)?/i, extract: (m: RegExpMatchArray) => parseInt(m[1]) },
		{ regex: /ultimo?\s+(\d+)\s+mes(?:es)?/i, extract: (m: RegExpMatchArray) => parseInt(m[1]) },
		{ regex: /(\d+)\s+mes(?:es)?/i, extract: (m: RegExpMatchArray) => parseInt(m[1]) },
		{ regex: /último\s+año|ultimo\s+año/i, extract: () => 12 },
		{ regex: /12\s*mes(?:es)?/i, extract: () => 12 },
		{ regex: /6\s*mes(?:es)?/i, extract: () => 6 },
		{ regex: /3\s*mes(?:es)?/i, extract: () => 3 },
	];

	let monthsBack = 6;

	for (const pattern of patterns) {
		const match = q.match(pattern.regex);
		if (match) {
			const extracted = pattern.extract(match);
			if (extracted && extracted > 0 && extracted <= 60) {
				monthsBack = extracted;
				break;
			}
		}
	}

	if (q.includes('este mes') || q.includes('mes actual') || q.includes('actual')) {
		monthsBack = 1;
	}

	const toMonth = new Date(today);
	const fromMonth = new Date(toMonth);
	fromMonth.setMonth(fromMonth.getMonth() - (monthsBack - 1));

	return {
		fromMonth: monthStartStr(fromMonth),
		toMonth: monthStartStr(toMonth),
		monthsBack,
	};
}
