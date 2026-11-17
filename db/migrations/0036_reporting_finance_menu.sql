-- ClinicRME — migrasi 0036 (Stage 14 batch 2): menu laporan keuangan (RPT-FR-003, 004, 007; DEC-047).
SET search_path = app, public;

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('report.revenue', 'report', 'Pendapatan', '/reports/revenue', 'chart', 'report.finance.read', 530),
  ('report.cashier_closing', 'report', 'Closing kasir', '/reports/cashier-closing', 'chart', 'report.finance.read', 540),
  ('report.receivables', 'report', 'Umur piutang', '/reports/receivables', 'chart', 'report.finance.read', 550)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;

CREATE INDEX IF NOT EXISTS ix_invoice_report_issued ON invoice(tenant_id, issued_at) WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID');
CREATE INDEX IF NOT EXISTS ix_payment_report_received ON payment(tenant_id, received_at);
