export interface EmailSender {
	id: string;
	from_name: string;
	from_email: string;
	reply_to_email?: string;
}

export interface EffectiveEmailSender {
	from_name: string;
	from_email: string;
	reply_to_email?: string;
}
