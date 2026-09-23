-- Secuencia public.invoice_number_seq, sin columna dueña (no viene de un serial/identity),
-- así que ninguna entity la declara. El valor actual es dato y no se versiona.

CREATE SEQUENCE IF NOT EXISTS "public"."invoice_number_seq"
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 9223372036854775807
	START WITH 1
	CACHE 1
	NO CYCLE;
