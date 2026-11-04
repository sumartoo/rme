-- ClinicRME — migrasi 0001: katalog permission & fungsi role template (salinan db/seed/010_permissions_roles.sql
-- yang dibangkitkan tools/gen_permission_matrix.py pada Stage 3). Perubahan matriks berikutnya = migrasi baru.
-- Dibangkitkan oleh tools/gen_permission_matrix.py — jangan diedit manual.
SET search_path = app, public;

INSERT INTO permission(code, module, description) VALUES
  ('appointment.manage', 'appointment', 'appointmentCancel; appointmentCreate; appointmentReschedule; followUpCreate'),
  ('appointment.read', 'appointment', 'appointmentList; slotList'),
  ('audit.log.read', 'audit', 'auditSearch'),
  ('billing.invoice.discount', 'billing', 'invoiceDiscount'),
  ('billing.invoice.issue', 'billing', 'invoiceIssue'),
  ('billing.invoice.read', 'billing', 'billingWorklist; invoiceForEncounter'),
  ('billing.invoice.void.approve', 'billing', 'invoiceVoidDecide'),
  ('billing.invoice.void.request', 'billing', 'invoiceVoidRequest'),
  ('billing.payment.create', 'billing', 'paymentCreate; qrisChargeCreate; qrisChargeGet'),
  ('billing.receivable.manage', 'billing', 'receivablePay'),
  ('billing.receivable.read', 'billing', 'receivableList'),
  ('billing.reconcile', 'billing', 'qrisReconciliation'),
  ('billing.refund.approve', 'billing', 'refundDecide'),
  ('billing.refund.request', 'billing', 'refundRequest'),
  ('billing.shift.manage', 'billing', 'shiftClose; shiftCurrent; shiftOpen'),
  ('clinical.document.issue', 'clinical', 'medicalDocumentIssue; referralCreate'),
  ('clinical.lab.order', 'clinical', 'labOrderCreate'),
  ('clinical.lab.result.write', 'clinical', 'labResultManual'),
  ('clinical.note.addendum', 'clinical', 'addendumCreate'),
  ('clinical.note.sign', 'clinical', 'encounterSign'),
  ('clinical.note.write', 'clinical', 'diagnosesSet; noteSave; procedureAdd'),
  ('clinical.prescription.approve_substitution', 'clinical', 'substitutionDecide'),
  ('clinical.prescription.write', 'clinical', 'prescriptionSave'),
  ('clinical.record.read', 'clinical', 'encounterChart; medicalDocumentGet; patientEncounterHistory'),
  ('clinical.record.write', 'clinical', 'allergyCreate; historyCreate'),
  ('clinical.vitals.write', 'clinical', 'vitalsRecord'),
  ('document.upload', 'document', 'fileUploadRequest'),
  ('encounter.cancel', 'encounter', 'encounterCancel'),
  ('encounter.create', 'encounter', 'appointmentCheckIn; encounterWalkIn'),
  ('encounter.read', 'encounter', 'encounterBoard'),
  ('iam.role.manage', 'iam', 'roleCreate; roleUpdate'),
  ('iam.role.read', 'iam', 'permissionList; roleList'),
  ('iam.user.manage', 'iam', 'userDisable; userInvite; userRevokeAllSessions'),
  ('iam.user.read', 'iam', 'userList'),
  ('integration.manage', 'integration', 'satusehatConfigure; satusehatRetry; satusehatSyncMaster; satusehatTest'),
  ('integration.read', 'integration', 'satusehatReconciliation; satusehatRecords; satusehatSummary'),
  ('master.export', 'master', 'masterExport'),
  ('master.facility.manage', 'master', 'branchCreate; unitCreate'),
  ('master.facility.read', 'master', 'branchList; unitList'),
  ('master.import', 'master', 'masterImport'),
  ('master.payer.manage', 'master', 'payerCreate'),
  ('master.payer.read', 'master', 'payerList'),
  ('master.practitioner.manage', 'master', 'practitionerCreate; practitionerUpdate'),
  ('master.practitioner.read', 'master', 'practitionerList'),
  ('master.service.manage', 'master', 'serviceItemCreate'),
  ('master.service.read', 'master', 'serviceItemList'),
  ('master.supplier.read', 'master', 'supplierList'),
  ('master.tariff.manage', 'master', 'tariffCreate'),
  ('master.tariff.read', 'master', 'tariffList'),
  ('master.uom.read', 'master', 'uomList'),
  ('patient.create', 'patient', 'patientCreate; patientDuplicateCheck'),
  ('patient.merge', 'patient', 'patientMerge'),
  ('patient.read', 'patient', 'patientGet; patientSearch'),
  ('patient.update', 'patient', 'patientConsentRecord; patientUpdate'),
  ('pharmacy.dispense', 'pharmacy', 'pharmacyWorklist; prescriptionDispense; prescriptionReview; substitutionRequest'),
  ('pharmacy.drug.manage', 'pharmacy', 'drugCreate'),
  ('pharmacy.drug.read', 'pharmacy', 'drugList'),
  ('pharmacy.otc.sell', 'pharmacy', 'otcSaleCreate'),
  ('pharmacy.stock.adjust', 'pharmacy', 'stockAdjustmentRequest'),
  ('pharmacy.stock.approve', 'pharmacy', 'opnameDecide; stockAdjustmentDecide'),
  ('pharmacy.stock.opname', 'pharmacy', 'opnameCount; opnameStart'),
  ('pharmacy.stock.read', 'pharmacy', 'stockAlerts; stockList'),
  ('pharmacy.stock.receive', 'pharmacy', 'goodsReceiptCreate'),
  ('platform.support.access', 'platform', 'platformSupportAccess'),
  ('platform.tenant.manage', 'platform', 'platformFeatureFlag; platformPlanList; platformTenantCreate; platformTenantList; platformTenantStatus'),
  ('queue.call', 'queue', 'queueCall; queueSkip'),
  ('queue.display', 'queue', 'queueBoard'),
  ('report.clinical.read', 'report', 'reportTopDiagnoses'),
  ('report.dashboard.read', 'report', 'dashboardToday'),
  ('report.export', 'report', 'reportExport'),
  ('report.finance.audit', 'report', 'reportAnomalies'),
  ('report.finance.read', 'report', 'reportCashierClosing; reportReceivables; reportRevenue'),
  ('report.operational.read', 'report', 'reportVisits'),
  ('report.pharmacy.controlled', 'report', 'reportControlledDrugs'),
  ('report.pharmacy.read', 'report', 'reportStock'),
  ('schedule.manage', 'schedule', 'scheduleCreate; scheduleExceptionCreate'),
  ('schedule.read', 'schedule', 'scheduleList'),
  ('tenant.data.export', 'tenant', 'tenantExportCreate; tenantExportGet'),
  ('tenant.profile.manage', 'tenant', 'tenantProfileUpdate'),
  ('tenant.profile.read', 'tenant', 'tenantProfileGet'),
  ('terminology.favorite.manage', 'terminology', 'conceptFavorite')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- Membuat role template untuk tenant aktif (dipanggil saat onboarding tenant, PLT-FR-001)
CREATE OR REPLACE FUNCTION app.create_template_roles() RETURNS void
LANGUAGE plpgsql SET search_path = app, public AS $$
DECLARE v_role uuid;
BEGIN
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'TENANT_ADMIN', 'Admin Klinik', true, true)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['audit.log.read', 'iam.role.manage', 'iam.role.read', 'iam.user.manage', 'iam.user.read', 'integration.manage', 'integration.read', 'master.export', 'master.facility.manage', 'master.facility.read', 'master.import', 'master.payer.manage', 'master.payer.read', 'master.practitioner.manage', 'master.practitioner.read', 'master.service.manage', 'master.service.read', 'master.supplier.read', 'master.tariff.manage', 'master.tariff.read', 'master.uom.read', 'patient.merge', 'patient.read', 'report.dashboard.read', 'report.operational.read', 'schedule.manage', 'schedule.read', 'tenant.data.export', 'tenant.profile.manage', 'tenant.profile.read', 'terminology.favorite.manage']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'DOKTER', 'Dokter', true, false)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['appointment.manage', 'appointment.read', 'clinical.document.issue', 'clinical.lab.order', 'clinical.lab.result.write', 'clinical.note.addendum', 'clinical.note.sign', 'clinical.note.write', 'clinical.prescription.approve_substitution', 'clinical.prescription.write', 'clinical.record.read', 'clinical.record.write', 'clinical.vitals.write', 'document.upload', 'encounter.read', 'master.facility.read', 'master.payer.read', 'master.practitioner.read', 'master.service.read', 'master.supplier.read', 'master.tariff.read', 'master.uom.read', 'patient.read', 'pharmacy.drug.read', 'queue.call', 'report.clinical.read', 'terminology.favorite.manage']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'PERAWAT', 'Perawat / Bidan', true, false)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['clinical.lab.result.write', 'clinical.record.read', 'clinical.record.write', 'clinical.vitals.write', 'document.upload', 'encounter.read', 'master.facility.read', 'master.payer.read', 'master.practitioner.read', 'master.service.read', 'master.supplier.read', 'master.tariff.read', 'master.uom.read', 'patient.read', 'queue.call']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'PENDAFTARAN', 'Petugas Pendaftaran', true, false)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['appointment.manage', 'appointment.read', 'document.upload', 'encounter.cancel', 'encounter.create', 'encounter.read', 'master.facility.read', 'master.payer.read', 'master.practitioner.read', 'master.service.read', 'master.supplier.read', 'master.tariff.read', 'master.uom.read', 'patient.create', 'patient.read', 'patient.update', 'queue.call', 'queue.display', 'schedule.read']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'FARMASI', 'Apoteker / TTK', true, false)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['clinical.record.read', 'encounter.read', 'master.facility.read', 'master.payer.read', 'master.practitioner.read', 'master.service.read', 'master.supplier.read', 'master.tariff.read', 'master.uom.read', 'patient.read', 'pharmacy.dispense', 'pharmacy.drug.manage', 'pharmacy.drug.read', 'pharmacy.otc.sell', 'pharmacy.stock.adjust', 'pharmacy.stock.opname', 'pharmacy.stock.read', 'pharmacy.stock.receive', 'report.pharmacy.controlled', 'report.pharmacy.read']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'KASIR', 'Kasir', true, false)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['billing.invoice.discount', 'billing.invoice.issue', 'billing.invoice.read', 'billing.invoice.void.request', 'billing.payment.create', 'billing.receivable.read', 'billing.refund.request', 'billing.shift.manage', 'encounter.read', 'master.facility.read', 'master.payer.read', 'master.practitioner.read', 'master.service.read', 'master.supplier.read', 'master.tariff.read', 'master.uom.read', 'patient.read', 'pharmacy.otc.sell']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'MANAJER', 'Manajer / Pemilik Klinik', true, true)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['audit.log.read', 'billing.invoice.read', 'billing.invoice.void.approve', 'billing.receivable.manage', 'billing.receivable.read', 'billing.reconcile', 'billing.refund.approve', 'integration.read', 'master.facility.read', 'master.payer.read', 'master.practitioner.read', 'master.service.read', 'master.supplier.read', 'master.tariff.read', 'master.uom.read', 'pharmacy.stock.approve', 'pharmacy.stock.read', 'report.clinical.read', 'report.dashboard.read', 'report.export', 'report.finance.audit', 'report.finance.read', 'report.operational.read', 'report.pharmacy.controlled', 'report.pharmacy.read']);
  END IF;
  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), 'AUDITOR', 'Auditor (baca saja)', true, true)
    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;
  IF v_role IS NOT NULL THEN
    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY['audit.log.read', 'billing.invoice.read', 'billing.receivable.read', 'integration.read', 'pharmacy.stock.read', 'report.clinical.read', 'report.dashboard.read', 'report.finance.audit', 'report.finance.read', 'report.operational.read', 'report.pharmacy.controlled', 'report.pharmacy.read']);
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION app.create_template_roles() TO clinicrme_app;
