# Permission Matrix — ClinicRME SaaS

> Dibangkitkan oleh `tools/gen_permission_matrix.py` dari `api/openapi.yaml` (x-permission) dan `db/seed/role_templates.yaml`. Jangan diedit manual.

**82 permission** · 8 role template tenant · 2 role platform · pemeriksaan: ✅ lulus

## Prinsip

- Format `<modul>.<resource>.<aksi>`; diperiksa di backend pada setiap endpoint (deny by default, AC-IAM-FR-011-2).
- Permission efektif = gabungan role user **di cabang aktif** (`user_role_assignment.branch_id`, NULL = semua cabang).
- Role template hanya titik awal; tenant admin dapat membuat role custom (IAM-FR-008).
- Segregation of duties (maker–checker) ditegakkan pada template **dan** di database (`approved_by <> requested_by`).

## Role Template

| Kode | Nama | MFA wajib | Jumlah permission | Catatan |
|---|---|---|---|---|
| `TENANT_ADMIN` | Admin Klinik | ✓ | 31 | Administrasi; tidak membaca rekam medis kecuali diberi role klinis |
| `DOKTER` | Dokter |  | 27 |  |
| `PERAWAT` | Perawat / Bidan |  | 15 |  |
| `PENDAFTARAN` | Petugas Pendaftaran |  | 19 |  |
| `FARMASI` | Apoteker / TTK |  | 20 |  |
| `KASIR` | Kasir |  | 18 |  |
| `MANAJER` | Manajer / Pemilik Klinik | ✓ | 25 |  |
| `AUDITOR` | Auditor (baca saja) | ✓ | 12 |  |
| `PLATFORM_ADMIN` | Platform Admin | ✓ | 2 |  |
| `PLATFORM_SUPPORT` | Platform Support | ✓ | 2 |  |

## Segregation of Duties

| Pengaju | Penyetuju |
|---|---|
| `billing.refund.request` | `billing.refund.approve` |
| `billing.invoice.void.request` | `billing.invoice.void.approve` |
| `pharmacy.stock.adjust` | `pharmacy.stock.approve` |

## Matriks

| Permission | TENANT_ADMIN | DOKTER | PERAWAT | PENDAFTARAN | FARMASI | KASIR | MANAJER | AUDITOR | Operasi API |
|---|---|---|---|---|---|---|---|---|---|
| **appointment** | | | | | | | | | |
| `appointment.manage` |  | ✓ |  | ✓ |  |  |  |  | appointmentCancel; appointmentCreate; appointmentReschedule; followUpCreate |
| `appointment.read` |  | ✓ |  | ✓ |  |  |  |  | appointmentList; slotList |
| **audit** | | | | | | | | | |
| `audit.log.read` | ✓ |  |  |  |  |  | ✓ | ✓ | auditSearch |
| **billing** | | | | | | | | | |
| `billing.invoice.discount` |  |  |  |  |  | ✓ |  |  | invoiceDiscount |
| `billing.invoice.issue` |  |  |  |  |  | ✓ |  |  | invoiceIssue |
| `billing.invoice.read` |  |  |  |  |  | ✓ | ✓ | ✓ | billingWorklist; invoiceForEncounter |
| `billing.invoice.void.approve` |  |  |  |  |  |  | ✓ |  | invoiceVoidDecide |
| `billing.invoice.void.request` |  |  |  |  |  | ✓ |  |  | invoiceVoidRequest |
| `billing.payment.create` |  |  |  |  |  | ✓ |  |  | paymentCreate; qrisChargeCreate; qrisChargeGet |
| `billing.receivable.manage` |  |  |  |  |  |  | ✓ |  | receivablePay |
| `billing.receivable.read` |  |  |  |  |  | ✓ | ✓ | ✓ | receivableList |
| `billing.reconcile` |  |  |  |  |  |  | ✓ |  | qrisReconciliation |
| `billing.refund.approve` |  |  |  |  |  |  | ✓ |  | refundDecide |
| `billing.refund.request` |  |  |  |  |  | ✓ |  |  | refundRequest |
| `billing.shift.manage` |  |  |  |  |  | ✓ |  |  | shiftClose; shiftCurrent; shiftOpen |
| **clinical** | | | | | | | | | |
| `clinical.document.issue` |  | ✓ |  |  |  |  |  |  | medicalDocumentIssue; referralCreate |
| `clinical.lab.order` |  | ✓ |  |  |  |  |  |  | labOrderCreate |
| `clinical.lab.result.write` |  | ✓ | ✓ |  |  |  |  |  | labResultManual |
| `clinical.note.addendum` |  | ✓ |  |  |  |  |  |  | addendumCreate |
| `clinical.note.sign` |  | ✓ |  |  |  |  |  |  | encounterSign |
| `clinical.note.write` |  | ✓ |  |  |  |  |  |  | diagnosesSet; noteSave; procedureAdd |
| `clinical.prescription.approve_substitution` |  | ✓ |  |  |  |  |  |  | substitutionDecide |
| `clinical.prescription.write` |  | ✓ |  |  |  |  |  |  | prescriptionSave |
| `clinical.record.read` |  | ✓ | ✓ |  | ✓ |  |  |  | encounterChart; medicalDocumentGet; patientEncounterHistory |
| `clinical.record.write` |  | ✓ | ✓ |  |  |  |  |  | allergyCreate; historyCreate |
| `clinical.vitals.write` |  | ✓ | ✓ |  |  |  |  |  | vitalsRecord |
| **document** | | | | | | | | | |
| `document.upload` |  | ✓ | ✓ | ✓ |  |  |  |  | fileUploadRequest |
| **encounter** | | | | | | | | | |
| `encounter.cancel` |  |  |  | ✓ |  |  |  |  | encounterCancel |
| `encounter.create` |  |  |  | ✓ |  |  |  |  | appointmentCheckIn; encounterWalkIn |
| `encounter.read` |  | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | encounterBoard |
| **iam** | | | | | | | | | |
| `iam.role.manage` | ✓ |  |  |  |  |  |  |  | roleCreate; roleUpdate |
| `iam.role.read` | ✓ |  |  |  |  |  |  |  | permissionList; roleList |
| `iam.user.manage` | ✓ |  |  |  |  |  |  |  | userDisable; userEnable; userInvite; userResetMfa; userRevokeAllSessions |
| `iam.user.read` | ✓ |  |  |  |  |  |  |  | userInvitationList; userList |
| **integration** | | | | | | | | | |
| `integration.manage` | ✓ |  |  |  |  |  |  |  | satusehatConfigure; satusehatRetry; satusehatSyncMaster; satusehatTest |
| `integration.read` | ✓ |  |  |  |  |  | ✓ | ✓ | satusehatReconciliation; satusehatRecords; satusehatSummary |
| **master** | | | | | | | | | |
| `master.export` | ✓ |  |  |  |  |  |  |  | masterExport |
| `master.facility.manage` | ✓ |  |  |  |  |  |  |  | branchCreate; unitCreate |
| `master.facility.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | branchList; unitList |
| `master.import` | ✓ |  |  |  |  |  |  |  | masterImport |
| `master.payer.manage` | ✓ |  |  |  |  |  |  |  | payerCreate |
| `master.payer.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | payerList |
| `master.practitioner.manage` | ✓ |  |  |  |  |  |  |  | practitionerCreate; practitionerUpdate |
| `master.practitioner.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | practitionerList |
| `master.service.manage` | ✓ |  |  |  |  |  |  |  | serviceItemCreate |
| `master.service.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | serviceItemList |
| `master.supplier.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | supplierList |
| `master.tariff.manage` | ✓ |  |  |  |  |  |  |  | tariffCreate |
| `master.tariff.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | tariffList |
| `master.uom.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | uomList |
| **patient** | | | | | | | | | |
| `patient.create` |  |  |  | ✓ |  |  |  |  | patientCreate; patientDuplicateCheck |
| `patient.merge` | ✓ |  |  |  |  |  |  |  | patientMerge |
| `patient.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | patientGet; patientSearch |
| `patient.update` |  |  |  | ✓ |  |  |  |  | patientConsentRecord; patientUpdate |
| **pharmacy** | | | | | | | | | |
| `pharmacy.dispense` |  |  |  |  | ✓ |  |  |  | pharmacyWorklist; prescriptionDispense; prescriptionReview; substitutionRequest |
| `pharmacy.drug.manage` |  |  |  |  | ✓ |  |  |  | drugCreate |
| `pharmacy.drug.read` |  | ✓ |  |  | ✓ |  |  |  | drugList |
| `pharmacy.otc.sell` |  |  |  |  | ✓ | ✓ |  |  | otcSaleCreate |
| `pharmacy.stock.adjust` |  |  |  |  | ✓ |  |  |  | stockAdjustmentRequest |
| `pharmacy.stock.approve` |  |  |  |  |  |  | ✓ |  | opnameDecide; stockAdjustmentDecide |
| `pharmacy.stock.opname` |  |  |  |  | ✓ |  |  |  | opnameCount; opnameStart |
| `pharmacy.stock.read` |  |  |  |  | ✓ |  | ✓ | ✓ | stockAlerts; stockList |
| `pharmacy.stock.receive` |  |  |  |  | ✓ |  |  |  | goodsReceiptCreate |
| **queue** | | | | | | | | | |
| `queue.call` |  | ✓ | ✓ | ✓ |  |  |  |  | queueCall; queueSkip |
| `queue.display` |  |  |  | ✓ |  |  |  |  | queueBoard |
| **report** | | | | | | | | | |
| `report.clinical.read` |  | ✓ |  |  |  |  | ✓ | ✓ | reportTopDiagnoses |
| `report.dashboard.read` | ✓ |  |  |  |  |  | ✓ | ✓ | dashboardToday |
| `report.export` |  |  |  |  |  |  | ✓ |  | reportExport |
| `report.finance.audit` |  |  |  |  |  |  | ✓ | ✓ | reportAnomalies |
| `report.finance.read` |  |  |  |  |  |  | ✓ | ✓ | reportCashierClosing; reportReceivables; reportRevenue |
| `report.operational.read` | ✓ |  |  |  |  |  | ✓ | ✓ | reportVisits |
| `report.pharmacy.controlled` |  |  |  |  | ✓ |  | ✓ | ✓ | reportControlledDrugs |
| `report.pharmacy.read` |  |  |  |  | ✓ |  | ✓ | ✓ | reportStock |
| **schedule** | | | | | | | | | |
| `schedule.manage` | ✓ |  |  |  |  |  |  |  | scheduleCreate; scheduleExceptionCreate |
| `schedule.read` | ✓ |  |  | ✓ |  |  |  |  | scheduleList |
| **tenant** | | | | | | | | | |
| `tenant.data.export` | ✓ |  |  |  |  |  |  |  | tenantExportCreate; tenantExportDownload; tenantExportGet; tenantExportKey; tenantExportList |
| `tenant.profile.manage` | ✓ |  |  |  |  |  |  |  | tenantProfileUpdate |
| `tenant.profile.read` | ✓ |  |  |  |  |  |  |  | tenantProfileGet |
| **terminology** | | | | | | | | | |
| `terminology.favorite.manage` | ✓ | ✓ |  |  |  |  |  |  | conceptFavorite |

## Permission Platform

| Permission | PLATFORM_ADMIN | PLATFORM_SUPPORT | Operasi API |
|---|---|---|---|
| `platform.support.access` |  | ✓ | platformSupportAccess; platformSupportAuditLog; platformSupportUsers |
| `platform.tenant.manage` | ✓ |  | platformFeatureFlag; platformTenantCreate; platformTenantStatus |
| `platform.tenant.read` | ✓ | ✓ | platformPlanList; platformTenantGet; platformTenantList |
