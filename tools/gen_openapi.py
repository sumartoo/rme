"""Bangkitkan draft api/openapi.yaml (Stage 2, design-first; ADR-0008).

Setiap operasi membawa `x-requirements` (ID requirement SRS) dan `x-permission`
sehingga RTM dapat dipetakan otomatis (tools/gen_rtm.py).
Pemakaian: python3 tools/gen_openapi.py api/openapi.yaml   (butuh: pip install pyyaml)
Mulai Stage 4 sumber kebenaran pindah ke kode NestJS; file ini dipakai sebagai pembanding.
"""
import sys, yaml

# ---------------------------------------------------------------------------
# Skema
# ---------------------------------------------------------------------------
def ref(n): return {"$ref": f"#/components/schemas/{n}"}
def arr(n): return {"type": "array", "items": ref(n) if isinstance(n, str) else n}
S = lambda **kw: {"type": "string", **kw}
UUID = {"type": "string", "format": "uuid"}
DATE = {"type": "string", "format": "date"}
DT = {"type": "string", "format": "date-time"}
INT = {"type": "integer"}
BOOL = {"type": "boolean"}
MONEY = {"type": "string", "pattern": r"^-?\d{1,16}(\.\d{1,2})?$", "description": "Rupiah sebagai string desimal (jangan pakai float)", "example": "150000.00"}
QTY = {"type": "string", "pattern": r"^\d{1,14}(\.\d{1,4})?$", "example": "10"}
def enum(*v): return {"type": "string", "enum": list(v)}
def obj(required=(), **props):
    o = {"type": "object", "properties": props}
    if required: o["required"] = list(required)
    return o

PAYER_TYPE = enum("UMUM", "ASURANSI", "PERUSAHAAN", "BPJS")
schemas = {
  "Problem": obj(["type", "title", "status"], type=S(format="uri"), title=S(), status=INT, detail=S(),
                 instance=S(), code=S(description="Kode error stabil, mis. PAT-409-DUPLICATE"),
                 errors=arr(obj(field=S(), message=S())),
                 candidates=arr("PatientSummary")),
  "PageInfo": obj(["hasMore"], nextCursor={"type": ["string", "null"]}, hasMore=BOOL),
  # IAM
  "AuthSession": obj(["email", "tenant", "mfaRequired", "mfaEnrolled", "mfaVerified"], email=S(format="email"), fullName=S(),
                     tenant=obj(["code", "name"], code=S(), name=S()), mfaRequired=BOOL, mfaEnrolled=BOOL, mfaVerified=BOOL),
  "Me": obj(["user", "tenant", "activeBranch", "permissions"], user=ref("User"), tenant=obj(id=UUID, name=S(), type=S()),
            activeBranch=ref("Branch"), activeBranchId={"type": ["string", "null"], "format": "uuid"}, branches=arr("Branch"), permissions=arr(S()), mfaVerified=BOOL),
  "MenuItem": obj(["code", "label"], code=S(), label=S(), route=S(), icon=S(), children=arr("MenuItem")),
  "User": obj(["id", "email", "fullName", "status"], id=UUID, email=S(format="email"), fullName=S(), phone=S(),
              status=enum("ACTIVE", "DISABLED"), practitionerId={"type": ["string", "null"], "format": "uuid"}, roles=arr(S()), branchIds=arr(UUID)),
  "InvitationCreate": obj(["email", "roleIds"], email=S(format="email"), fullName=S(), roleIds=arr(UUID), branchIds=arr(UUID), practitionerId=UUID),
  "Invitation": obj(["id", "email", "expiresAt"], id=UUID, email=S(), expiresAt=DT, acceptedAt={"type": ["string", "null"], "format": "date-time"},
                    clinicName=S(), roles=arr(S()), createdAt=DT),
  "InvitationAccept": obj(["fullName", "password"], fullName=S(minLength=2), password=S(format="password", minLength=10)),
  "PasswordLogin": obj(["email", "password"], email=S(format="email"), password=S(format="password")),
  "MfaVerify": obj(["code"], code=S(pattern=r"^\d{6}$")),
  "BranchSelect": obj(["branchId"], branchId=UUID),
  "Role": obj(["id", "code", "name", "permissions"], id=UUID, code=S(), name=S(), isTemplate=BOOL, requiresMfa=BOOL, mfaLocked=BOOL,
              permissions=arr(S()), userCount={"type": "integer"}, version={"type": "integer"}),
  "RoleUpsert": obj(["code", "name", "permissions"], code=S(), name=S(), requiresMfa=BOOL, permissions=arr(S())),
  "RoleUpdate": obj(name=S(), requiresMfa=BOOL, permissions=arr(S())),
  "Session": obj(["id", "createdAt"], id=UUID, userAgent=S(), ip=S(), createdAt=DT, lastSeenAt=DT, current=BOOL),
  # Master
  # Stage 7 batch 1 (DEC-031): fasilitas + ubah cabang/unit/nakes; NIK hanya ditulis, dibaca sebagai nikMasked
  "Facility": obj(["id", "name", "facilityType"], id=UUID, name=S(), facilityType=enum("KLINIK_UTAMA", "KLINIK_PRATAMA", "PRAKTIK_MANDIRI"),
                  licenseNumber=S(), isActive=BOOL, version=INT),
  "Branch": obj(["id", "code", "name"], id=UUID, facilityId=UUID, code=S(), name=S(), address=S(), regionCode=S(), phone=S(),
                timezone=enum("Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"), isActive=BOOL, version=INT),
  "ServiceUnit": obj(["id", "code", "name", "unitType"], id=UUID, branchId=UUID, code=S(), name=S(),
                     unitType=enum("POLI", "RUANG", "FARMASI", "KASIR", "LAB", "LAINNYA"), specialty=S(),
                     queuePrefix={"type": ["string", "null"], "pattern": "^[A-Z]{1,3}$", "description": "Awalan nomor antrean (OD-086); kosong = huruf pertama kode"},
                     isActive=BOOL, version=INT),
  "Practitioner": obj(["id", "fullName", "practitionerType"], id=UUID, fullName=S(), practitionerType=S(), specialty=S(),
                      nik=S(pattern=r"^\d{16}$", writeOnly=True), nikMasked=S(readOnly=True),
                      strNumber=S(), strValidUntil=DATE, sipNumber=S(), sipValidUntil=DATE, satusehatIhsId=S(),
                      isActive=BOOL, linkedUserId={"type": ["string", "null"], "format": "uuid", "readOnly": True}, version=INT),
  "ServiceItem": obj(["id", "code", "name", "serviceType"], id=UUID, code=S(), name=S(),
                     serviceType=enum("KONSULTASI", "TINDAKAN", "PAKET", "ADMINISTRASI", "LAB", "LAINNYA"), icd9cmCode=S(), isActive=BOOL, version=INT),
  "Tariff": obj(["serviceItemId", "price", "validFrom"], id=UUID, serviceItemId=UUID, branchId=UUID, payerType=PAYER_TYPE,
                payerId=UUID, price=MONEY, validFrom=DATE, validTo=DATE,
                closePrevious={"type": "boolean", "writeOnly": True, "description": "Tutup periode sebelumnya yang masih berlaku pada validFrom"}),
  "Payer": obj(["id", "code", "name", "payerType"], id=UUID, code=S(), name=S(), payerType=PAYER_TYPE, isActive=BOOL, version=INT,
               contract=obj(contractNumber=S(), validUntil=DATE, plafon=MONEY, copayPercent={"type": "number"}, paymentTermDays=INT, notes=S())),
  "Uom": obj(["id", "code", "name"], id=UUID, code=S(), name=S(), isActive=BOOL, version=INT,
             conversions=arr(obj(toUomId=UUID, factor=S(pattern=r"^\d{1,12}(\.\d{1,6})?$")))),
  "Supplier": obj(["id", "name"], id=UUID, code=S(), name=S(), contactPerson=S(), phone=S(), email=S(format="email"), address=S(),
                  npwp=S(), isActive=BOOL, version=INT),
  # Stage 7 batch 4: impor sinkron (tanpa job tersimpan); dryRun=true (bawaan) tidak menyimpan; commit hanya bila tanpa error
  "ImportJob": obj(["entity", "status", "dryRun", "rowCount"], entity=S(), status=enum("VALIDATED", "COMMITTED", "FAILED"), dryRun=BOOL,
                   rowCount=INT, created=INT, updated=INT, errors=arr(obj(row=INT, field=S(), message=S()))),
  "Concept": obj(["system", "code", "display"], id=UUID, system=enum("ICD10", "ICD9CM", "KFA"), code=S(), display=S(), displayEn=S(),
                 synonyms=arr(S()), isFavorite=BOOL,
                 favorite={"oneOf": [{"type": "null"}, obj(specialty=S(), validated=BOOL, validatedAt=DT, validatedBy=S())]}),
  "CodeSystem": obj(["code", "version"], code=S(), version=S(), source=S(), effectiveDate=DATE, isCurrent=BOOL, conceptCount=INT, isSample=BOOL),
  # Patient
  "PatientInput": obj(["fullName", "birthDate", "sex", "identityType"], fullName=S(maxLength=200), birthDate=DATE,
                      sex=enum("L", "P", "TIDAK_DIKETAHUI"),
                      identityType=enum("NIK", "PASPOR", "KITAS", "BAYI_IDENTITAS_IBU", "TANPA_IDENTITAS"),
                      nik=S(pattern=r"^\d{16}$", writeOnly=True), identityValue=S(writeOnly=True), motherPatientId=UUID,
                      phone=S(), email=S(format="email"), address=S(), regionCode=S(),
                      contacts=arr("PatientContact"), coverages=arr("CoverageInput"),
                      duplicateOverrideReason=S(description="Wajib bila kandidat duplikat diabaikan (AC-REG-FR-004-2)")),
  # Stage 8 batch 1 (DEC-035): NIK/paspor hanya ditulis; dibaca tersamar. Penjamin & consent lewat endpoint sendiri.
  "PatientUpdate": obj(fullName=S(maxLength=200), birthDate=DATE, sex=enum("L", "P", "TIDAK_DIKETAHUI"),
                       identityType=enum("NIK", "PASPOR", "KITAS", "BAYI_IDENTITAS_IBU", "TANPA_IDENTITAS"),
                       nik={"type": ["string", "null"], "pattern": r"^\d{16}$", "writeOnly": True}, identityValue={"type": ["string", "null"], "writeOnly": True},
                       motherPatientId={"type": ["string", "null"], "format": "uuid"}, phone=S(), email=S(format="email"), address=S(), regionCode=S(),
                       contacts=arr("PatientContact")),
  "Patient": obj(["id", "mrn", "fullName", "birthDate", "sex"], id=UUID, mrn=S(), fullName=S(), birthDate=DATE, sex=S(),
                 identityType=S(), nikMasked=S(example="3174********0001"), identityMasked=S(), phone=S(), email=S(), address=S(), regionCode=S(),
                 ihsStatus=enum("PENDING", "FOUND", "NOT_FOUND", "NOT_APPLICABLE", "ERROR"), status=enum("ACTIVE", "MERGED", "DECEASED", "INACTIVE"),
                 mother=ref("PatientSummary"), mergedInto=ref("PatientSummary"), mergedAt=DT, mergeReason=S(),
                 processingRestricted=BOOL, restrictionReason=S(), restrictedAt=DT, registeredBranchId=UUID, createdAt=DT,
                 contacts=arr("PatientContact"), coverages=arr("Coverage"), consents=arr("PatientConsent"),
                 allergies=arr("Allergy"), hasConsent=BOOL, hasActiveCoverage=BOOL, version=INT),
  "PatientSummary": obj(["id", "mrn", "fullName", "birthDate"], id=UUID, mrn=S(), fullName=S(), birthDate=DATE, sex=S(), nikMasked=S(), phone=S(),
                        status=S(), identityType=S(), identityMasked=S(), score={"type": "number"}),
  "DuplicateCandidates": obj(["candidates"], exactNikMatch=BOOL, candidates=arr("PatientSummary")),
  "PatientContact": obj(["relation", "fullName", "phone"], id={"type": "string", "format": "uuid", "readOnly": True}, relation=S(), fullName=S(), phone=S(), isGuardian=BOOL),
  "CoverageInput": obj(["payerId"], payerId=UUID, memberNo=S(), planName=S(), employeeNo=S(), bpjsFaskesCode=S(), validFrom=DATE, validTo=DATE),
  "Coverage": obj(["id", "payerId", "payerType"], id=UUID, payerId=UUID, payerName=S(), payerType=PAYER_TYPE, memberNo=S(), planName=S(),
                  employeeNo=S(), bpjsFaskesCode=S(), validFrom=DATE, validTo=DATE, isActive=BOOL, version=INT),
  "CoverageUpdate": obj(memberNo=S(), planName=S(), employeeNo=S(), bpjsFaskesCode=S(), validFrom=DATE, validTo=DATE, isActive=BOOL),
  "PatientConsent": obj(["id", "consentType", "version", "granted"], id=UUID, consentType=S(), version=S(), title=S(), granted=BOOL,
                        signedByName=S(), signedByRelation=S(), recordedAt=DT, revokedAt={"type": ["string", "null"], "format": "date-time"}),
  "ConsentDocument": obj(["consentType", "version", "title", "content"], id={"type": "string", "format": "uuid", "readOnly": True},
                         consentType=enum("UMUM", "DATA_SHARING", "PORTAL"), version=S(), title=S(), content=S(),
                         effectiveAt={"type": "string", "format": "date-time", "readOnly": True}),
  "ConsentInput": obj(["consentDocumentId", "granted"], consentDocumentId=UUID, granted=BOOL, signedByName=S(), signedByRelation=S()),
  "MergeRequest": obj(["sourcePatientId", "targetPatientId", "reason"], sourcePatientId=UUID, targetPatientId=UUID, reason=S()),
  # Scheduling
  # Scheduling (Stage 8 batch 2): jam = jam lokal cabang; slot & janji temu = waktu ber-zona
  "Schedule": obj(["practitionerId", "branchId", "unitId", "dayOfWeek", "startTime", "endTime"], id={"type": "string", "format": "uuid", "readOnly": True},
                  practitionerId=UUID, practitionerName={"type": "string", "readOnly": True}, branchId=UUID, branchName={"type": "string", "readOnly": True},
                  unitId=UUID, unitName={"type": "string", "readOnly": True}, timezone={"type": "string", "readOnly": True},
                  dayOfWeek={"type": "integer", "minimum": 1, "maximum": 7, "description": "1 = Senin"}, startTime=S(pattern=r"^\d{2}:\d{2}$"),
                  endTime=S(pattern=r"^\d{2}:\d{2}$"), slotMinutes={"type": "integer", "minimum": 5, "maximum": 120},
                  quota={"type": "integer", "minimum": 1, "description": "Bawaan = jumlah slot; maksimal jumlah slot (OD-090)"},
                  slotCount={"type": "integer", "readOnly": True}, validFrom=DATE, validTo=DATE, isActive={"type": "boolean", "readOnly": True},
                  version={"type": "integer", "readOnly": True}),
  "ScheduleUpdate": obj(dayOfWeek={"type": "integer", "minimum": 1, "maximum": 7}, startTime=S(), endTime=S(), slotMinutes=INT, quota=INT,
                        validFrom=DATE, validTo=DATE, isActive=BOOL),
  "ScheduleException": obj(["exceptionDate", "reason"], id={"type": "string", "format": "uuid", "readOnly": True},
                           practitionerId=UUID, practitionerName={"type": "string", "readOnly": True}, branchId=UUID, branchName={"type": "string", "readOnly": True},
                           exceptionDate=DATE, reason=S(minLength=3),
                           affectedAppointments={"type": "array", "items": {"$ref": "#/components/schemas/Appointment"}, "readOnly": True}),
  "Slot": obj(["start", "end", "available"], start=DT, end=DT, available=BOOL, taken=BOOL),
  "SlotDay": obj(["date", "sessions"], date=DATE, sessions={"type": "array", "items": {"allOf": [{"$ref": "#/components/schemas/Schedule"}, obj(
                   booked=INT, closed={"type": ["object", "null"], "properties": {"reason": S(), "type": enum("CUTI_DOKTER", "LIBUR_CABANG")}},
                   slots=arr("Slot"))]}}),
  "AppointmentCreate": obj(["patientId", "practitionerId", "slotStart"], patientId=UUID, practitionerId=UUID, unitId=UUID, slotStart=DT, notes=S(maxLength=500)),
  "Appointment": obj(["id", "status", "slotStart"], id=UUID, patient=ref("PatientSummary"), practitionerId=UUID, practitionerName=S(),
                     branchId=UUID, branchName=S(), unitId=UUID, unitName=S(), scheduleId=UUID, slotStart=DT, slotEnd=DT, localDate=DATE,
                     localTime=S(), timezone=S(), channel=enum("STAFF", "PATIENT_APP", "FOLLOW_UP"), notes=S(),
                     status=enum("BOOKED", "CHECKED_IN", "CANCELLED", "NO_SHOW", "RESCHEDULED"), statusReason=S(), rescheduledToId=UUID,
                     createdAt=DT, version=INT),
  "ReasonInput": obj(["reason"], reason=S(minLength=3)),
  "RescheduleInput": obj(["slotStart", "reason"], slotStart=DT, practitionerId=UUID, reason=S(minLength=3)),
  # Kunjungan & antrean (Stage 8 batch 3). Penjamin Asuransi/Perusahaan wajib eligibilityNote (verifikasi manual, OD-032)
  "WalkInCreate": obj(["patientId", "unitId", "practitionerId"], patientId=UUID, unitId=UUID, practitionerId=UUID, coverageId=UUID,
                      eligibilityNote=S(maxLength=500)),
  "CheckInInput": obj(coverageId=UUID, eligibilityNote=S(maxLength=500)),
  "Encounter": obj(["id", "encounterNo", "status"], id=UUID, encounterNo=S(example="KJ202611000123"), patient=ref("PatientSummary"),
                   branchId=UUID, branchName=S(), unitId=UUID, unitName=S(), practitionerId=UUID, practitionerName=S(), payerType=PAYER_TYPE,
                   coverage=obj(id=UUID, payerName=S(), memberNo=S()), coverageVerifiedAt=DT, coverageVerificationNote=S(),
                   arrivalType=enum("WALK_IN", "APPOINTMENT"), arrivedLate=BOOL, appointment=obj(id=UUID, slotStart=DT),
                   status=enum("REGISTERED", "ARRIVED", "TRIAGED", "IN_CONSULTATION", "CONSULT_DONE", "PHARMACY", "BILLING", "FINISHED", "CANCELLED"),
                   cancelReason=S(), queue=ref("QueueTicket"), arrivedAt=DT, localDate=DATE, localTime=S(), warnings=arr(S()), version=INT),
  "QueueTicket": obj(["id", "displayCode", "status"], id=UUID, displayCode=S(example="A-012"), queueNumber=INT, unitId=UUID, unitName=S(),
                     practitionerId=UUID, practitionerName=S(), encounterId=UUID, encounterNo=S(), patient=ref("PatientSummary"),
                     status=enum("WAITING", "CALLED", "SKIPPED", "SERVED", "CANCELLED"), calledAt=DT, callCount=INT, skippedAt=DT,
                     arrivalType=S(), arrivedLate=BOOL, version=INT),
  "QueueBoard": obj(["unitId", "nowServing"], unitId=UUID, unitName=S(), nowServing=ref("QueueTicket"), waiting=INT, recentlyCalled=arr("QueueTicket")),
  # Clinical
  "EncounterChart": obj(["encounter", "patient"], encounter=ref("Encounter"), patient=ref("Patient"), note=ref("ClinicalNote"),
                        vitals=arr("Vital"), diagnoses=arr("Diagnosis"), procedures=arr("Procedure"), prescriptions=arr("Prescription"),
                        labOrders=arr("LabOrder"), history=arr(obj(encounterId=UUID, date=DT, diagnoses=arr(S()), medications=arr(S())))),
  "ClinicalNote": obj(["id", "status"], id=UUID, templateCode=S(), subjective=S(), objective=S(), assessment=S(), plan=S(),
                      structured={"type": "object"}, status=enum("DRAFT", "SIGNED"), signedBy=UUID, signedAt=DT,
                      addenda=arr("Addendum"), version=INT),
  "ClinicalNoteUpdate": obj(["version"], templateCode=S(), subjective=S(), objective=S(), assessment=S(), plan=S(), structured={"type": "object"}, version=INT),
  "Vital": obj(["code", "value"], id=UUID, code=enum("SYSTOLIC", "DIASTOLIC", "HEART_RATE", "RESP_RATE", "TEMPERATURE", "SPO2", "WEIGHT", "HEIGHT", "BMI", "PAIN_SCALE", "OTHER"),
               value=S(), unit=S(), recordedAt=DT),
  "VitalsInput": obj(["items"], items=arr("Vital")),
  "Allergy": obj(["substance", "category"], id=UUID, substance=S(), category=enum("OBAT", "MAKANAN", "LINGKUNGAN", "LAINNYA"),
                 reaction=S(), severity=enum("RINGAN", "SEDANG", "BERAT"), status=enum("ACTIVE", "INACTIVE", "ENTERED_IN_ERROR")),
  "HistoryEntry": obj(["historyType", "description"], id=UUID, historyType=enum("PENYAKIT", "OBAT_RUTIN", "KELUARGA", "SOSIAL", "OPERASI"), description=S()),
  "Diagnosis": obj(["conceptId", "rank"], id=UUID, conceptId=UUID, code=S(), display=S(), rank=enum("PRIMER", "SEKUNDER"), caseStatus=enum("BARU", "LAMA"), note=S()),
  "Procedure": obj(["serviceItemId"], id=UUID, conceptId=UUID, serviceItemId=UUID, performedBy=UUID, qty=QTY),
  "PrescriptionItem": obj(["frequency", "route", "qty", "uomId"], id=UUID, lineNo=INT, isCompound=BOOL, drugItemId=UUID, compoundName=S(),
                          compoundForm=S(), components=arr(obj(["drugItemId", "qty", "uomId"], drugItemId=UUID, qty=QTY, uomId=UUID)),
                          dose=S(), frequency=S(), route=S(), durationDays=INT, qty=QTY, uomId=UUID, instructions=S(), qtyDispensed=QTY),
  "PrescriptionInput": obj(["items"], items=arr("PrescriptionItem"), acknowledgedWarnings=arr(obj(code=S(), reason=S()))),
  "Prescription": obj(["id", "prescriptionNo", "status", "items"], id=UUID, prescriptionNo=S(),
                      status=enum("DRAFT", "ISSUED", "VERIFIED", "PARTIALLY_DISPENSED", "DISPENSED", "CANCELLED"),
                      items=arr("PrescriptionItem"), warnings=arr("ClinicalWarning")),
  "ClinicalWarning": obj(["code", "message"], code=enum("ALLERGY", "DUPLICATE_DRUG", "DOSE_FORMAT"), message=S(), itemLineNo=INT),
  "LabOrderInput": obj(["serviceItemIds"], serviceItemIds=arr(UUID), clinicalInfo=S()),
  "LabOrder": obj(["id", "orderNo", "status"], id=UUID, orderNo=S(), status=enum("ORDERED", "SENT", "RECEIVED", "RESULTED", "CANCELLED", "ERROR"),
                  items=arr(obj(id=UUID, serviceItemId=UUID, name=S())), results=arr("LabResult")),
  "LabResult": obj(["source"], id=UUID, labOrderItemId=UUID, source=enum("CONNECTOR", "MANUAL", "UPLOAD"), testName=S(), value=S(),
                   unit=S(), referenceRange=S(), flag=S(), fileId=UUID, resultedAt=DT),
  "SignResult": obj(["noteId", "signedAt", "contentHash"], noteId=UUID, signedAt=DT, contentHash=S()),
  "SignValidationError": obj(["missing"], missing=arr(S())),
  "AddendumInput": obj(["reason", "content"], reason=S(minLength=3), content=S(), changes={"type": "object"}),
  "Addendum": obj(["id", "reason", "content", "signedAt"], id=UUID, reason=S(), content=S(), authorId=UUID, signedAt=DT),
  "DocumentInput": obj(["docType"], docType=enum("RESUME", "SURAT_SEHAT", "SURAT_SAKIT", "RUJUKAN"), data={"type": "object"}),
  "MedicalDocument": obj(["id", "documentNo", "docType", "downloadUrl"], id=UUID, documentNo=S(), docType=S(), issuedAt=DT,
                         downloadUrl=S(format="uri", description="Signed URL ≤ 5 menit")),
  "ReferralInput": obj(["destination", "reason"], destination=S(), destinationUnit=S(), reason=S(), clinicalSummary=S()),
  "FollowUpInput": obj(["date"], date=DATE, practitionerId=UUID, unitId=UUID, note=S()),
  "FileUploadTicket": obj(["fileId", "uploadUrl"], fileId=UUID, uploadUrl=S(format="uri"), expiresAt=DT),
  "FileUploadRequest": obj(["contentType", "sizeBytes", "category"], contentType=enum("application/pdf", "image/jpeg", "image/png"),
                           sizeBytes={"type": "integer", "maximum": 10485760}, category=enum("UPLOAD", "LAB_RESULT"), patientId=UUID),
  # Pharmacy
  "Drug": obj(["id", "code", "genericName", "drugClass"], id=UUID, code=S(), genericName=S(), brandName=S(), dosageForm=S(), strength=S(),
              baseUomId=UUID, drugClass=enum("BEBAS", "BEBAS_TERBATAS", "KERAS", "NARKOTIKA", "PSIKOTROPIKA", "PREKURSOR", "ALKES", "LAINNYA"),
              kfaCode=S(), ingredients=arr(S()), minStock=QTY),
  "StockLevel": obj(["drugId", "qtyOnHand"], drugId=UUID, drugName=S(), locationId=UUID, qtyOnHand=QTY, batches=arr("Batch"), belowMinimum=BOOL),
  "Batch": obj(["id", "batchNo", "expiryDate"], id=UUID, batchNo=S(), expiryDate=DATE, qtyOnHand=QTY),
  "GoodsReceiptInput": obj(["supplierId", "locationId", "invoiceNo", "lines"], supplierId=UUID, locationId=UUID, invoiceNo=S(),
                           lines=arr(obj(["drugItemId", "batchNo", "expiryDate", "qty", "uomId", "unitPrice"], drugItemId=UUID, batchNo=S(),
                                         expiryDate=DATE, qty=QTY, uomId=UUID, unitPrice=MONEY))),
  "GoodsReceipt": obj(["id", "receiptNo"], id=UUID, receiptNo=S(), receivedAt=DT),
  "PrescriptionReview": obj(["administrative", "pharmaceutical", "clinical"], administrative=BOOL, pharmaceutical=BOOL, clinical=BOOL, notes=S()),
  "DispenseInput": obj(["locationId", "lines"], locationId=UUID, handedTo=S(),
                       lines=arr(obj(["prescriptionItemId", "qty"], prescriptionItemId=UUID, qty=QTY, batchId={**UUID, "description": "Opsional; default FEFO"}))),
  "Dispense": obj(["id", "prescriptionStatus"], id=UUID, prescriptionStatus=S(), lines=arr(obj(prescriptionItemId=UUID, batchId=UUID, qty=QTY)), labelUrl=S(format="uri")),
  "SubstitutionRequest": obj(["prescriptionItemId", "newDrugItemId", "reason"], prescriptionItemId=UUID, newDrugItemId=UUID, reason=S()),
  "Substitution": obj(["id", "status"], id=UUID, status=enum("PENDING", "APPROVED", "REJECTED"), approvedBy=UUID),
  "OtcSaleInput": obj(["locationId", "lines"], locationId=UUID, patientId=UUID, lines=arr(obj(["drugItemId", "qty"], drugItemId=UUID, qty=QTY))),
  "OtcSale": obj(["id", "saleNo", "invoiceId"], id=UUID, saleNo=S(), invoiceId=UUID),
  "AdjustmentInput": obj(["batchId", "locationId", "qtyDelta", "reason"], batchId=UUID, locationId=UUID, qtyDelta=S(pattern=r"^-?\d+(\.\d{1,4})?$"), reason=S()),
  "Adjustment": obj(["id", "status"], id=UUID, status=enum("REQUESTED", "APPROVED", "REJECTED")),
  "Opname": obj(["id", "status"], id=UUID, locationId=UUID, status=enum("COUNTING", "SUBMITTED", "APPROVED", "CANCELLED"),
                lines=arr(obj(batchId=UUID, systemQty=QTY, countedQty=QTY, note=S()))),
  "OpnameCountInput": obj(["lines"], lines=arr(obj(["batchId", "countedQty"], batchId=UUID, countedQty=QTY, note=S()))),
  "StockAlert": obj(["type", "drugId"], type=enum("BELOW_MINIMUM", "NEAR_EXPIRY", "EXPIRED"), drugId=UUID, drugName=S(), batchId=UUID, expiryDate=DATE, qtyOnHand=QTY),
  # Billing
  "Invoice": obj(["id", "status", "netAmount", "lines"], id=UUID, invoiceNo=S(), status=enum("DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"),
                 grossAmount=MONEY, discountAmount=MONEY, netAmount=MONEY, payerPortion=MONEY, patientPortion=MONEY, paidAmount=MONEY,
                 outstanding=MONEY, lines=arr("InvoiceLine"), payments=arr("Payment"), version=INT),
  "InvoiceLine": obj(["lineNo", "description", "qty", "unitPrice", "lineTotal"], lineNo=INT, sourceType=S(), description=S(), qty=QTY,
                     unitPrice=MONEY, discountAmount=MONEY, lineTotal=MONEY, payerPortion=MONEY, patientPortion=MONEY),
  "DiscountInput": obj(["lineNo", "amount"], lineNo=INT, amount=MONEY, reason=S()),
  "PaymentInput": obj(["method", "amount"], method=enum("TUNAI", "DEBIT", "KARTU_KREDIT", "TRANSFER"), amount=MONEY, cashTendered=MONEY, reference=S()),
  "Payment": obj(["id", "receiptNo", "method", "amount"], id=UUID, receiptNo=S(), method=S(), amount=MONEY, change=MONEY, receivedAt=DT, receiptUrl=S(format="uri")),
  "QrisChargeInput": obj(["amount"], amount=MONEY),
  "QrisCharge": obj(["id", "qrPayload", "expiresAt", "status"], id=UUID, qrPayload=S(), amount=MONEY, expiresAt=DT, status=enum("PENDING", "PAID", "EXPIRED", "FAILED", "CANCELLED")),
  "GatewayCallback": {"type": "object", "description": "Payload sesuai provider (OD-039); diverifikasi signature-nya", "additionalProperties": True},
  "VoidInput": obj(["reason"], reason=S(minLength=3)),
  "ApprovalDecision": obj(["decision"], decision=enum("APPROVE", "REJECT"), note=S()),
  "VoidRequest": obj(["id", "status"], id=UUID, invoiceId=UUID, reason=S(), status=enum("REQUESTED", "APPROVED", "REJECTED")),
  "RefundInput": obj(["paymentId", "amount", "reason", "method"], paymentId=UUID, amount=MONEY, reason=S(minLength=3), method=S()),
  "Refund": obj(["id", "refundNo", "status", "amount"], id=UUID, refundNo=S(), paymentId=UUID, amount=MONEY, reason=S(), status=enum("REQUESTED", "APPROVED", "REJECTED"),
                requestedBy=UUID, approvedBy=UUID),
  "ShiftOpenInput": obj(["openingCash"], openingCash=MONEY),
  "ShiftCloseInput": obj(["countedCash"], countedCash=MONEY, denominations={"type": "object", "additionalProperties": INT}, varianceNote=S()),
  "Shift": obj(["id", "status", "openingCash"], id=UUID, status=enum("OPEN", "CLOSED", "VERIFIED"), openedAt=DT, closedAt=DT, openingCash=MONEY,
               expectedCash=MONEY, countedCash=MONEY, variance=MONEY, totalsByMethod={"type": "object", "additionalProperties": MONEY}),
  "Receivable": obj(["id", "payerId", "amount", "paidAmount"], id=UUID, invoiceId=UUID, payerId=UUID, payerName=S(), amount=MONEY, paidAmount=MONEY, dueDate=DATE, status=S()),
  "ReceivablePaymentInput": obj(["amount", "reference"], amount=MONEY, reference=S(), receivedAt=DATE),
  # Integration
  "IntegrationConnectionInput": obj(["facilityId", "environment", "clientId", "clientSecret", "organizationId"], facilityId=UUID,
                                    environment=enum("SANDBOX", "PRODUCTION"), clientId=S(), clientSecret=S(writeOnly=True), organizationId=S()),
  "IntegrationConnection": obj(["id", "environment"], id=UUID, facilityId=UUID, environment=S(), lastTestAt=DT, lastTestOk=BOOL),
  "ConnectionTest": obj(["ok"], ok=BOOL, message=S()),
  "SyncSummary": obj(["date", "sent", "pending", "error"], date=DATE, sent=INT, pending=INT, error=INT, dead=INT),
  "SyncRecord": obj(["id", "resourceType", "status"], id=UUID, resourceType=S(), localType=S(), localId=UUID, satusehatId=S(),
                    status=enum("PENDING", "SENT", "ERROR", "DEAD", "SKIPPED"), attempts=INT, lastError=S(), lastSentAt=DT),
  "ReconciliationRow": obj(["encounterId", "issue"], encounterId=UUID, encounterNo=S(), signedAt=DT, issue=enum("NOT_SENT", "PARTIAL", "ERROR")),
  # Audit & report & platform
  "AuditEntry": obj(["seq", "occurredAt", "action", "resourceType"], seq=INT, occurredAt=DT, actorUserId=UUID, actorName=S(), action=S(),
                    resourceType=S(), resourceId=UUID, patientId=UUID, ip=S(), changeSummary={"type": "object"}),
  "ReportResult": obj(["columns", "rows"], columns=arr(obj(key=S(), label=S(), type=S())), rows=arr({"type": "object"}),
                      totals={"type": "object"}, generatedAt=DT, dataAsOf=DT),
  "ExportJob": obj(["id", "status"], id=UUID, status=enum("QUEUED", "RUNNING", "DONE", "FAILED", "EXPIRED"), downloadUrl=S(format="uri"), expiresAt=DT),
  "ExportRequest": obj(["format"], format=enum("XLSX", "CSV", "PDF"), parameters={"type": "object"}),
  "Dashboard": obj(["date"], date=DATE, visits=INT, finished=INT, waiting=INT, revenue=MONEY, satusehatPending=INT, satusehatError=INT),
  "TenantCreate": obj(["code", "legalName", "tenantType", "planId", "adminEmail"], code=S(pattern=r"^[a-z0-9-]{3,40}$"), legalName=S(), displayName=S(),
                      tenantType=enum("KLINIK_UTAMA", "KLINIK_PRATAMA", "PRAKTIK_MANDIRI"), planId=UUID, adminEmail=S(format="email"), trialDays={"type": "integer", "minimum": 0, "maximum": 90}),
  "Tenant": obj(["id", "code", "status"], id=UUID, code=S(), legalName=S(), displayName=S(), tenantType=S(),
                status=enum("PROVISIONING", "TRIAL", "ACTIVE", "GRACE", "SUSPENDED", "TERMINATED"), plan=obj(id=UUID, code=S(), maxUsers=INT, maxBranches=INT),
                trialEndsAt={"type": ["string", "null"], "format": "date-time"}, createdAt=DT,
                featureFlags={"type": "object", "additionalProperties": BOOL, "description": "Hanya di detail tenant"},
                allowedTransitions=arr(S(description="Status tujuan yang sah dari status sekarang (detail tenant)"))),
  "TenantStatusChange": obj(["status", "reason"], status=enum("TRIAL", "ACTIVE", "GRACE", "SUSPENDED", "TERMINATED"), reason=S(minLength=3, maxLength=500)),
  "TenantExportJob": obj(["id", "status", "requestedAt"], id=UUID, status=enum("QUEUED", "RUNNING", "DONE", "FAILED", "EXPIRED"),
                         requestedAt=DT, finishedAt={"type": ["string", "null"], "format": "date-time"},
                         expiresAt={"type": ["string", "null"], "format": "date-time"}, sizeBytes={"type": ["integer", "null"]},
                         sha256={"type": ["string", "null"]}, tableCount={"type": ["integer", "null"]}, rowCount={"type": ["integer", "null"]},
                         error={"type": ["string", "null"]},
                         downloadUrl={"type": ["string", "null"], "description": "Path API unduhan (bukan signed URL) — setiap unduhan teraudit"}),
  "TenantExportKey": obj(["algorithm", "key"], algorithm=S(enum=["AES-256-GCM"]), key=S(description="Kunci 32 byte, base64")),
  "TenantProfile": obj(["displayName"], displayName=S(minLength=2, maxLength=200), letterhead={**obj(name=S(), address=S(), phone=S(), license=S()), "type": ["object", "null"]},
                       logoFileId={"type": ["string", "null"], "format": "uuid", "description": "Unggah logo: Stage 9 (DOC-FR-003)"},
                       version={"type": "integer", "readOnly": True, "description": "Sama dengan ETag; kirim di If-Match"},
                       settings={"type": "object", "description": "Mis. pharmacyBeforeCashier, discountLimit, noShowMinutes, mrnPrefix (0–5 huruf, OD-081)"}),
  "SupportAccessInput": obj(["tenantId", "reason", "durationMinutes"], tenantId=UUID, reason=S(minLength=10, maxLength=500), durationMinutes={"type": "integer", "minimum": 15, "maximum": 480}),
  "SupportAccess": obj(["id", "tenantId", "reason", "startsAt", "expiresAt", "active"], id=UUID, tenantId=UUID, tenantCode=S(), platformUserId=UUID,
                       supportName=S(), reason=S(), startsAt=DT, expiresAt=DT, revokedAt={"type": ["string", "null"], "format": "date-time"}, active=BOOL),
  "SupportTenantUser": obj(["id", "email", "status", "roles"], id=UUID, email=S(), fullName=S(), status=S(),
                           lastLoginAt={"type": ["string", "null"], "format": "date-time"}, roles=arr(S())),
  "SupportAuditEntry": obj(["seq", "occurredAt", "action"], seq=INT, occurredAt=DT, actorKind=S(), actorUserId={"type": ["string", "null"], "format": "uuid"},
                           action=S(), resourceType=S(), resourceId={"type": ["string", "null"], "format": "uuid"}),
  "PlatformMe": obj(["id", "email", "roles", "permissions", "mfaVerified"], id=UUID, email=S(format="email"), fullName=S(),
                    roles=arr(enum("PLATFORM_ADMIN", "PLATFORM_SUPPORT")), permissions=arr(S()), mfaVerified=BOOL, mfaEnrolled=BOOL),
  "Plan": obj(["id", "code", "maxUsers", "maxBranches"], id=UUID, code=S(), name=S(), maxUsers=INT, maxBranches=INT, features={"type": "object"}),
}

# ---------------------------------------------------------------------------
# Operasi: (method, path, operationId, tag, summary, requirements, permission, body, response, opts)
# opts: page=list paginated, idem=Idempotency-Key, match=If-Match, code=status sukses, public=tanpa auth, list=array
# ---------------------------------------------------------------------------
P = "/api/v1"
PP = "/api/platform/v1"   # konsol platform (CR-0001)
ops = [
 # Auth & IAM
 ("get",  f"{P}/auth/google", "authGoogleStart", "Auth", "Mulai login Google (redirect 302)", ["IAM-FR-002"], None, None, None, {"public": 1, "code": "302"}),
 ("get",  f"{P}/auth/google/callback", "authGoogleCallback", "Auth", "Callback OAuth Google; buat sesi", ["IAM-FR-002"], None, None, None, {"public": 1, "code": "302"}),
 ("post", f"{P}/auth/login", "authPasswordLogin", "Auth", "Login email & password", ["IAM-FR-003"], None, "PasswordLogin", "Me", {"public": 1}),
 ("post", f"{P}/auth/password-reset", "authPasswordResetRequest", "Auth", "Minta tautan reset password (respons selalu sama)", ["IAM-FR-004", "NTF-FR-001"], None, obj(["email"], email=S(format="email")), None, {"public": 1, "code": "202"}),
 ("post", f"{P}/auth/password-reset/confirm", "authPasswordResetConfirm", "Auth", "Set password baru dengan token", ["IAM-FR-004"], None, obj(["token", "password"], token=S(), password=S(format="password")), None, {"public": 1, "code": "204"}),
 ("post", f"{P}/auth/mfa/verify", "authMfaVerify", "Auth", "Verifikasi TOTP untuk sesi", ["IAM-FR-005"], None, "MfaVerify", "Me", {}),
 ("post", f"{P}/auth/mfa/enroll", "authMfaEnroll", "Auth", "Mulai pendaftaran TOTP (secret + recovery codes)", ["IAM-FR-005"], None, None, obj(otpauthUrl=S(), recoveryCodes=arr(S())), {}),
 ("post", f"{P}/auth/logout", "authLogout", "Auth", "Akhiri sesi", ["AUD-FR-001"], None, None, None, {"code": "204"}),
 ("get",  f"{P}/invitations/{{token}}", "invitationGet", "Auth", "Detail undangan (sebelum login)", ["IAM-FR-001"], None, None, "Invitation", {"public": 1}),
 ("post", f"{P}/invitations/{{token}}/accept", "invitationAccept", "Auth", "Terima undangan dengan membuat password (OD-078)", ["IAM-FR-001", "IAM-FR-003"], None, "InvitationAccept", obj(ok=BOOL), {"public": 1, "code": "201"}),
 ("get",  f"{P}/auth/session", "authSession", "Auth", "Status sesi (boleh sebelum MFA): langkah MFA berikutnya, tanpa permission", ["IAM-FR-005"], None, None, "AuthSession", {}),
 ("get",  f"{P}/me", "meGet", "IAM", "Profil, tenant, cabang aktif, permission", ["IAM-FR-009", "IAM-FR-010"], None, None, "Me", {}),
 ("post", f"{P}/me/branch", "meSelectBranch", "IAM", "Pilih cabang aktif", ["IAM-FR-009"], None, "BranchSelect", "BranchSelect", {}),
 ("get",  f"{P}/me/menu", "meMenu", "IAM", "Menu sesuai permission efektif", ["IAM-FR-010"], None, None, "MenuItem", {"list": 1}),
 ("get",  f"{P}/me/sessions", "meSessions", "IAM", "Daftar sesi aktif", ["IAM-FR-013"], None, None, "Session", {"list": 1}),
 ("delete", f"{P}/me/sessions/{{sessionId}}", "meRevokeSession", "IAM", "Cabut sesi", ["IAM-FR-013"], None, None, None, {"code": "204"}),
 ("get",  f"{P}/users", "userList", "IAM", "Daftar user", ["IAM-FR-001"], "iam.user.read", None, "User", {"page": 1}),
 ("get",  f"{P}/users/invitations", "userInvitationList", "IAM", "Undangan aktif yang belum diterima", ["IAM-FR-001"], "iam.user.read", None, "Invitation", {"list": 1}),
 ("post", f"{P}/users/invitations", "userInvite", "IAM", "Undang user (cek kuota paket)", ["IAM-FR-001", "IAM-FR-016", "PLT-FR-004", "NTF-FR-001"], "iam.user.manage", "InvitationCreate", "Invitation", {"code": "201"}),
 ("post", f"{P}/users/{{userId}}/disable", "userDisable", "IAM", "Nonaktifkan user & cabut semua sesi", ["IAM-FR-014"], "iam.user.manage", "ReasonInput", "User", {}),
 ("post", f"{P}/users/{{userId}}/practitioner", "userLinkPractitioner", "IAM", "Tautkan/lepas tenaga kesehatan (dasar tanda tangan klinis)", ["IAM-FR-016"], "iam.user.manage", obj(["practitionerId"], practitionerId={"type": ["string", "null"], "format": "uuid"}), obj(id=UUID, practitionerId={"type": ["string", "null"], "format": "uuid"}), {}),
 ("post", f"{P}/users/{{userId}}/enable", "userEnable", "IAM", "Aktifkan kembali user (kuota paket berlaku)", ["IAM-FR-014", "PLT-FR-004"], "iam.user.manage", None, "User", {}),
 ("delete", f"{P}/users/{{userId}}/mfa", "userResetMfa", "IAM", "Reset MFA user (authenticator hilang); semua sesi dicabut", ["IAM-FR-005", "IAM-FR-013"], "iam.user.manage", None, None, {"code": "204"}),
 ("delete", f"{P}/users/{{userId}}/sessions", "userRevokeAllSessions", "IAM", "Cabut seluruh sesi user", ["IAM-FR-013"], "iam.user.manage", None, None, {"code": "204"}),
 ("get",  f"{P}/roles", "roleList", "IAM", "Daftar role", ["IAM-FR-007"], "iam.role.read", None, "Role", {"list": 1}),
 ("post", f"{P}/roles", "roleCreate", "IAM", "Buat role custom", ["IAM-FR-008"], "iam.role.manage", "RoleUpsert", "Role", {"code": "201"}),
 ("put",  f"{P}/roles/{{roleId}}", "roleUpdate", "IAM", "Ubah role & permission", ["IAM-FR-008"], "iam.role.manage", "RoleUpdate", "Role", {"match": 1}),
 ("get",  f"{P}/permissions", "permissionList", "IAM", "Katalog permission", ["IAM-FR-008", "IAM-FR-011"], "iam.role.read", None, obj(code=S(), module=S(), description=S()), {"list": 1}),
 # Audit
 ("get",  f"{P}/audit-logs", "auditSearch", "Audit", "Cari audit (user, pasien, aksi, periode)", ["AUD-FR-001", "AUD-FR-002", "AUD-FR-004"], "audit.log.read", None, "AuditEntry", {"page": 1}),
 # Platform
 # Konsol platform (host admin.<domain>, cookie crme_psession) — CR-0001
 ("post", f"{PP}/auth/login", "platformAuthLogin", "Platform", "Login konsol platform (email & password; TOTP wajib sesudahnya)", ["PLT-FR-001", "IAM-FR-005"], None, "PasswordLogin", obj(["mfaEnrolled"], mfaEnrolled=BOOL), {"public": 1, "platform": 1}),
 ("post", f"{PP}/auth/mfa/enroll", "platformAuthMfaEnroll", "Platform", "Daftarkan TOTP (hanya bila belum terdaftar)", ["IAM-FR-005"], None, None, obj(otpauthUrl=S(), recoveryCodes=arr(S())), {"platform": 1}),
 ("post", f"{PP}/auth/mfa/verify", "platformAuthMfaVerify", "Platform", "Verifikasi TOTP; sesi dirotasi", ["IAM-FR-005"], None, "MfaVerify", None, {"platform": 1, "code": "204"}),
 ("post", f"{PP}/auth/logout", "platformAuthLogout", "Platform", "Akhiri sesi konsol", ["AUD-FR-001"], None, None, None, {"platform": 1, "code": "204"}),
 ("get",  f"{PP}/me", "platformMe", "Platform", "Profil pengguna platform & permission", ["PLT-FR-001"], None, None, "PlatformMe", {"platform": 1}),
 ("get",  f"{PP}/plans", "platformPlanList", "Platform", "Daftar paket", ["PLT-FR-003"], "platform.tenant.read", None, "Plan", {"list": 1, "platform": 1}),
 ("post", f"{PP}/tenants", "platformTenantCreate", "Platform", "Buat tenant & undang tenant admin", ["PLT-FR-001", "PLT-FR-002", "PLT-FR-003"], "platform.tenant.manage", "TenantCreate", "Tenant", {"code": "201", "platform": 1}),
 ("get",  f"{PP}/tenants", "platformTenantList", "Platform", "Daftar tenant", ["PLT-FR-001"], "platform.tenant.read", None, "Tenant", {"page": 1, "platform": 1}),
 ("get",  f"{PP}/tenants/{{tenantId}}", "platformTenantGet", "Platform", "Detail tenant (tanpa data klinis)", ["PLT-FR-001", "PLT-FR-009"], "platform.tenant.read", None, "Tenant", {"platform": 1}),
 ("post", f"{PP}/tenants/{{tenantId}}/status", "platformTenantStatus", "Platform", "Ubah status tenant (alasan wajib)", ["PLT-FR-005", "PLT-FR-006", "PLT-FR-013"], "platform.tenant.manage", "TenantStatusChange", "Tenant", {"platform": 1}),
 ("put",  f"{PP}/tenants/{{tenantId}}/feature-flags/{{feature}}", "platformFeatureFlag", "Platform", "Aktif/nonaktifkan fitur", ["PLT-FR-011"], "platform.tenant.manage", obj(["enabled"], enabled=BOOL), None, {"code": "204", "platform": 1}),
 ("post", f"{PP}/support-access", "platformSupportAccess", "Platform", "Break-glass akses dukungan (≤ 8 jam, email ke tenant admin)", ["PLT-FR-009"], "platform.support.access", "SupportAccessInput", "SupportAccess", {"code": "201", "platform": 1, "notfound": 1}),
 ("get",  f"{PP}/support-access", "platformSupportAccessList", "Platform", "Daftar akses dukungan (support: miliknya; admin: semua)", ["PLT-FR-009"], None, None, "SupportAccess", {"list": 1, "platform": 1}),
 ("post", f"{PP}/support-access/{{grantId}}/revoke", "platformSupportAccessRevoke", "Platform", "Cabut akses dukungan (pemilik atau admin platform)", ["PLT-FR-009"], None, None, "SupportAccess", {"platform": 1, "forbidden": 1}),
 ("get",  f"{PP}/support-access/{{grantId}}/users", "platformSupportUsers", "Platform", "Baca user & role tenant selama grant berlaku (teraudit)", ["PLT-FR-009"], "platform.support.access", None, "SupportTenantUser", {"list": 1, "platform": 1}),
 ("get",  f"{PP}/support-access/{{grantId}}/audit-log", "platformSupportAuditLog", "Platform", "Baca log audit tenant selama grant berlaku (teraudit, tanpa data pasien)", ["PLT-FR-009"], "platform.support.access", None, "SupportAuditEntry", {"page": 1, "platform": 1}),
 ("get",  f"{P}/tenant/profile", "tenantProfileGet", "Tenant", "Profil & pengaturan klinik", ["PLT-FR-007"], "tenant.profile.read", None, "TenantProfile", {}),
 ("put",  f"{P}/tenant/profile", "tenantProfileUpdate", "Tenant", "Ubah profil, kop, logo, pengaturan", ["PLT-FR-007", "DOC-FR-001"], "tenant.profile.manage", "TenantProfile", "TenantProfile", {"match": 1}),
 ("post", f"{P}/tenant/exports", "tenantExportCreate", "Tenant", "Minta ekspor seluruh data tenant (satu ekspor aktif per tenant)", ["PLT-FR-008"], "tenant.data.export", None, "TenantExportJob", {"code": "202"}),
 ("get",  f"{P}/tenant/exports", "tenantExportList", "Tenant", "Riwayat ekspor (20 terakhir)", ["PLT-FR-008"], "tenant.data.export", None, "TenantExportJob", {"list": 1}),
 ("get",  f"{P}/tenant/exports/{{jobId}}", "tenantExportGet", "Tenant", "Status ekspor", ["PLT-FR-008"], "tenant.data.export", None, "TenantExportJob", {}),
 ("get",  f"{P}/tenant/exports/{{jobId}}/key", "tenantExportKey", "Tenant", "Kunci dekripsi arsip (teraudit)", ["PLT-FR-008"], "tenant.data.export", None, "TenantExportKey", {}),
 ("get",  f"{P}/tenant/exports/{{jobId}}/file", "tenantExportDownload", "Tenant", "Unduh arsip terenkripsi (teraudit, 410 bila kedaluwarsa)", ["PLT-FR-008"], "tenant.data.export", None, None, {"binary": 1}),
 # Master
 ("get",  f"{P}/facilities", "facilityList", "Master", "Daftar fasilitas", ["MST-FR-001"], "master.facility.read", None, "Facility", {"list": 1}),
 ("post", f"{P}/facilities", "facilityCreate", "Master", "Tambah fasilitas", ["MST-FR-001", "MST-FR-009"], "master.facility.manage", "Facility", "Facility", {"code": "201"}),
 ("put",  f"{P}/facilities/{{facilityId}}", "facilityUpdate", "Master", "Ubah fasilitas", ["MST-FR-001", "MST-FR-009"], "master.facility.manage", "Facility", "Facility", {"match": 1}),
 ("get",  f"{P}/branches", "branchList", "Master", "Daftar cabang", ["MST-FR-001"], "master.facility.read", None, "Branch", {"list": 1}),
 ("post", f"{P}/branches", "branchCreate", "Master", "Buat cabang (cek kuota)", ["MST-FR-001", "PLT-FR-004"], "master.facility.manage", "Branch", "Branch", {"code": "201"}),
 ("put",  f"{P}/branches/{{branchId}}", "branchUpdate", "Master", "Ubah cabang (aktifkan ulang cek kuota)", ["MST-FR-001", "MST-FR-009", "PLT-FR-004"], "master.facility.manage", "Branch", "Branch", {"match": 1}),
 ("get",  f"{P}/service-units", "unitList", "Master", "Daftar poli/unit", ["MST-FR-001"], "master.facility.read", None, "ServiceUnit", {"list": 1}),
 ("post", f"{P}/service-units", "unitCreate", "Master", "Buat poli/unit", ["MST-FR-001"], "master.facility.manage", "ServiceUnit", "ServiceUnit", {"code": "201"}),
 ("put",  f"{P}/service-units/{{unitId}}", "unitUpdate", "Master", "Ubah poli/unit", ["MST-FR-001", "MST-FR-009"], "master.facility.manage", "ServiceUnit", "ServiceUnit", {"match": 1}),
 ("get",  f"{P}/practitioners", "practitionerList", "Master", "Daftar tenaga kesehatan", ["MST-FR-002"], "master.practitioner.read", None, "Practitioner", {"page": 1}),
 ("post", f"{P}/practitioners", "practitionerCreate", "Master", "Tambah tenaga kesehatan", ["MST-FR-002"], "master.practitioner.manage", "Practitioner", "Practitioner", {"code": "201"}),
 ("get",  f"{P}/practitioners/{{practitionerId}}", "practitionerGet", "Master", "Detail tenaga kesehatan", ["MST-FR-002"], "master.practitioner.read", None, "Practitioner", {}),
 ("put",  f"{P}/practitioners/{{practitionerId}}", "practitionerUpdate", "Master", "Ubah tenaga kesehatan", ["MST-FR-002", "MST-FR-009"], "master.practitioner.manage", "Practitioner", "Practitioner", {"match": 1}),
 ("get",  f"{P}/service-items", "serviceItemList", "Master", "Daftar layanan", ["MST-FR-004"], "master.service.read", None, "ServiceItem", {"page": 1}),
 ("post", f"{P}/service-items", "serviceItemCreate", "Master", "Tambah layanan", ["MST-FR-004"], "master.service.manage", "ServiceItem", "ServiceItem", {"code": "201"}),
 ("put",  f"{P}/service-items/{{serviceItemId}}", "serviceItemUpdate", "Master", "Ubah layanan", ["MST-FR-004", "MST-FR-009"], "master.service.manage", "ServiceItem", "ServiceItem", {"match": 1}),
 ("get",  f"{P}/tariffs", "tariffList", "Master", "Daftar tarif", ["MST-FR-005"], "master.tariff.read", None, "Tariff", {"page": 1}),
 ("post", f"{P}/tariffs", "tariffCreate", "Master", "Tambah periode tarif (tanpa tumpang tindih)", ["MST-FR-005"], "master.tariff.manage", "Tariff", "Tariff", {"code": "201"}),
 ("post", f"{P}/tariffs/{{tariffId}}/end", "tariffEnd", "Master", "Tutup periode tarif (tanggal akhir hanya dapat dimajukan)", ["MST-FR-005", "MST-FR-009"], "master.tariff.manage", obj(["validTo"], validTo=DATE), "Tariff", {}),
 ("get",  f"{P}/payers", "payerList", "Master", "Daftar penjamin", ["MST-FR-006"], "master.payer.read", None, "Payer", {"list": 1}),
 ("post", f"{P}/payers", "payerCreate", "Master", "Tambah penjamin", ["MST-FR-006", "BPJ-FR-004"], "master.payer.manage", "Payer", "Payer", {"code": "201"}),
 ("put",  f"{P}/payers/{{payerId}}", "payerUpdate", "Master", "Ubah penjamin & kontrak", ["MST-FR-006", "MST-FR-009"], "master.payer.manage", "Payer", "Payer", {"match": 1}),
 ("get",  f"{P}/suppliers", "supplierList", "Master", "Daftar supplier", ["MST-FR-010"], "master.supplier.read", None, "Supplier", {"list": 1}),
 ("post", f"{P}/suppliers", "supplierCreate", "Master", "Tambah supplier", ["MST-FR-010", "MST-FR-009"], "master.supplier.manage", "Supplier", "Supplier", {"code": "201"}),
 ("put",  f"{P}/suppliers/{{supplierId}}", "supplierUpdate", "Master", "Ubah supplier", ["MST-FR-010", "MST-FR-009"], "master.supplier.manage", "Supplier", "Supplier", {"match": 1}),
 ("get",  f"{P}/uoms", "uomList", "Master", "Satuan & konversi", ["MST-FR-007"], "master.uom.read", None, "Uom", {"list": 1}),
 ("post", f"{P}/uoms", "uomCreate", "Master", "Tambah satuan", ["MST-FR-007", "MST-FR-009"], "master.uom.manage", "Uom", "Uom", {"code": "201"}),
 ("put",  f"{P}/uoms/{{uomId}}", "uomUpdate", "Master", "Ubah satuan", ["MST-FR-007", "MST-FR-009"], "master.uom.manage", "Uom", "Uom", {"match": 1}),
 ("put",  f"{P}/uoms/{{uomId}}/conversions/{{toUomId}}", "uomConversionSet", "Master", "Tetapkan konversi (1 asal = factor × tujuan; tidak melingkar)", ["MST-FR-007"], "master.uom.manage", obj(["factor"], factor=S()), obj(fromUomId=UUID, toUomId=UUID, factor=S()), {}),
 ("delete", f"{P}/uoms/{{uomId}}/conversions/{{toUomId}}", "uomConversionDelete", "Master", "Hapus konversi", ["MST-FR-007"], "master.uom.manage", None, None, {"code": "204"}),
 ("get",  f"{P}/regions", "regionList", "Master", "Wilayah berjenjang (parent=kode)", ["MST-FR-011"], None, None, obj(code=S(), name=S(), level=INT), {"list": 1}),
 ("post", f"{P}/imports/{{entity}}", "masterImport", "Master", "Impor CSV/XLSX sebagai body mentah (?dryRun=true bawaan = validasi saja; maks 5.000 baris / 5 MB; wajib juga izin kelola entitas)", ["MST-FR-008"], "master.import", {"type": "string", "format": "binary"}, "ImportJob", {"upload": 1}),
 ("get",  f"{P}/exports/{{entity}}", "masterExport", "Master", "Ekspor / template (?format=csv|xlsx&template=true) — format dapat diimpor ulang; NIK tidak pernah diekspor", ["MST-FR-008"], "master.export", None, None, {"file": 1}),
 ("get",  f"{P}/terminology/concepts", "conceptSearch", "Terminology", "Cari ICD-10/ICD-9-CM/KFA (q, system, favorites=all|validated)", ["TRM-FR-001", "TRM-FR-002", "TRM-FR-004", "TRM-FR-005"], None, None, "Concept", {"list": 1}),
 ("get",  f"{P}/terminology/code-systems", "codeSystemList", "Terminology", "Sumber & versi code system (OD-030)", ["TRM-FR-001", "TRM-FR-002"], None, None, "CodeSystem", {"list": 1}),
 ("put",  f"{P}/terminology/favorites/{{conceptId}}", "conceptFavorite", "Terminology", "Tandai favorit & validasi (validator: dokter dengan SIP berlaku, OD-084)", ["TRM-FR-003"], "terminology.favorite.manage", obj(specialty=S(), validated=BOOL), None, {"code": "204"}),
 ("delete", f"{P}/terminology/favorites/{{conceptId}}", "conceptUnfavorite", "Terminology", "Hapus dari favorit", ["TRM-FR-003"], "terminology.favorite.manage", None, None, {"code": "204"}),
 # Patient
 ("get",  f"{P}/patients", "patientSearch", "Patient", "Cari pasien (q nama toleran salah ketik, nik, mrn, phone, birthDate)", ["REG-FR-003", "REG-FR-012"], "patient.read", None, "PatientSummary", {"page": 1}),
 ("post", f"{P}/patients/duplicate-check", "patientDuplicateCheck", "Patient", "Cek kandidat duplikat sebelum simpan", ["REG-FR-004"], "patient.create", "PatientInput", "DuplicateCandidates", {}),
 ("post", f"{P}/patients", "patientCreate", "Patient", "Registrasi pasien baru (MRN otomatis, lookup IHS asinkron)", ["REG-FR-001", "REG-FR-002", "REG-FR-004", "REG-FR-006", "REG-FR-007", "REG-FR-009", "REG-FR-011"], "patient.create", "PatientInput", "Patient", {"code": "201", "idem": 1}),
 ("get",  f"{P}/patients/{{patientId}}", "patientGet", "Patient", "Detail pasien (akses dicatat audit)", ["REG-FR-012", "AUD-FR-002"], "patient.read", None, "Patient", {}),
 ("put",  f"{P}/patients/{{patientId}}", "patientUpdate", "Patient", "Ubah data pasien (sebagian; contacts menggantikan daftar)", ["REG-FR-001", "REG-FR-006", "REG-FR-009"], "patient.update", "PatientUpdate", "Patient", {"match": 1}),
 ("post", f"{P}/patients/{{patientId}}/restriction", "patientRestrictionSet", "Patient", "Pembatasan pemrosesan atas permintaan pasien (OD-068)", ["REG-FR-001"], "patient.update", obj(["restricted", "reason"], restricted=BOOL, reason=S(minLength=5)), "Patient", {}),
 ("post", f"{P}/patients/{{patientId}}/coverages", "patientCoverageCreate", "Patient", "Tambah penjamin pasien", ["REG-FR-007"], "patient.update", "CoverageInput", "Coverage", {"code": "201"}),
 ("put",  f"{P}/patients/{{patientId}}/coverages/{{coverageId}}", "patientCoverageUpdate", "Patient", "Ubah / nonaktifkan penjamin pasien", ["REG-FR-007"], "patient.update", "CoverageUpdate", "Coverage", {"match": 1}),
 ("post", f"{P}/patients/{{patientId}}/consents", "patientConsentRecord", "Patient", "Catat consent", ["REG-FR-008"], "patient.update", "ConsentInput", "PatientConsent", {"code": "201"}),
 ("post", f"{P}/patients/{{patientId}}/consents/{{consentId}}/revoke", "patientConsentRevoke", "Patient", "Cabut consent (catatan tidak dihapus)", ["REG-FR-008"], "patient.update", obj(["reason"], reason=S(minLength=5)), "Patient", {}),
 ("get",  f"{P}/consent-documents", "consentDocumentList", "Patient", "Daftar teks consent berversi", ["REG-FR-008"], "patient.read", None, "ConsentDocument", {"list": 1}),
 ("post", f"{P}/consent-documents", "consentDocumentCreate", "Patient", "Terbitkan versi teks consent (tidak dapat diubah)", ["REG-FR-008"], "tenant.profile.manage", "ConsentDocument", "ConsentDocument", {"code": "201"}),
 ("post", f"{P}/patients/merge", "patientMerge", "Patient", "Gabungkan pasien duplikat", ["REG-FR-005"], "patient.merge", "MergeRequest", "Patient", {}),
 ("get",  f"{P}/patients/{{patientId}}/encounters", "patientEncounterHistory", "Patient", "Riwayat kunjungan", ["CLN-FR-016"], "clinical.record.read", None, "Encounter", {"page": 1}),
 ("post", f"{P}/patients/{{patientId}}/allergies", "allergyCreate", "Clinical", "Catat alergi", ["CLN-FR-006"], "clinical.record.write", "Allergy", "Allergy", {"code": "201"}),
 ("post", f"{P}/patients/{{patientId}}/history", "historyCreate", "Clinical", "Catat riwayat penyakit/obat rutin", ["CLN-FR-007"], "clinical.record.write", "HistoryEntry", "HistoryEntry", {"code": "201"}),
 ("post", f"{P}/files", "fileUploadRequest", "Document", "Minta signed URL unggah berkas", ["DOC-FR-003"], "document.upload", "FileUploadRequest", "FileUploadTicket", {"code": "201"}),
 # Scheduling
 ("get",  f"{P}/schedules", "scheduleList", "Scheduling", "Jadwal praktik", ["SCH-FR-001"], "schedule.read", None, "Schedule", {"list": 1}),
 ("post", f"{P}/schedules", "scheduleCreate", "Scheduling", "Buat jadwal (tolak bentrok)", ["SCH-FR-001"], "schedule.manage", "Schedule", "Schedule", {"code": "201"}),
 ("put",  f"{P}/schedules/{{scheduleId}}", "scheduleUpdate", "Scheduling", "Ubah jadwal (ditolak bila janji temu mendatang tidak lagi masuk)", ["SCH-FR-001"], "schedule.manage", "ScheduleUpdate", "Schedule", {"match": 1}),
 ("get",  f"{P}/schedule-exceptions", "scheduleExceptionList", "Scheduling", "Daftar cuti/libur (from, to)", ["SCH-FR-002"], "schedule.read", None, "ScheduleException", {"list": 1}),
 ("post", f"{P}/schedule-exceptions", "scheduleExceptionCreate", "Scheduling", "Cuti dokter / libur cabang (+ janji temu terdampak)", ["SCH-FR-002"], "schedule.manage", "ScheduleException", "ScheduleException", {"code": "201"}),
 ("delete", f"{P}/schedule-exceptions/{{exceptionId}}", "scheduleExceptionDelete", "Scheduling", "Hapus cuti/libur", ["SCH-FR-002"], "schedule.manage", None, None, {"code": "204"}),
 ("get",  f"{P}/slots", "slotList", "Scheduling", "Slot per sesi pada satu tanggal (date wajib; practitionerId, branchId, unitId)", ["SCH-FR-003"], "appointment.read", None, "SlotDay", {}),
 ("post", f"{P}/appointments", "appointmentCreate", "Scheduling", "Buat appointment (cek kuota)", ["SCH-FR-003"], "appointment.manage", "AppointmentCreate", "Appointment", {"code": "201", "idem": 1}),
 ("get",  f"{P}/appointments", "appointmentList", "Scheduling", "Daftar appointment (date/from/to, practitionerId, branchId, patientId, status)", ["SCH-FR-003"], "appointment.read", None, "Appointment", {"page": 1}),
 ("get",  f"{P}/appointments/{{appointmentId}}", "appointmentGet", "Scheduling", "Detail appointment", ["SCH-FR-003"], "appointment.read", None, "Appointment", {}),
 ("post", f"{P}/appointments/{{appointmentId}}/cancel", "appointmentCancel", "Scheduling", "Batalkan (alasan wajib)", ["SCH-FR-010"], "appointment.manage", "ReasonInput", "Appointment", {}),
 ("post", f"{P}/appointments/{{appointmentId}}/reschedule", "appointmentReschedule", "Scheduling", "Jadwal ulang", ["SCH-FR-010"], "appointment.manage", "RescheduleInput", "Appointment", {}),
 ("post", f"{P}/appointments/{{appointmentId}}/check-in", "appointmentCheckIn", "Scheduling", "Check-in janji temu hari ini → kunjungan & nomor antrean (toleransi terlambat OD-087)", ["SCH-FR-006", "SCH-FR-007"], "encounter.create", "CheckInInput", "Encounter", {"idem": 1}),
 ("post", f"{P}/encounters/walk-in", "encounterWalkIn", "Scheduling", "Kunjungan walk-in + nomor antrean", ["SCH-FR-005", "SCH-FR-007"], "encounter.create", "WalkInCreate", "Encounter", {"code": "201", "idem": 1}),
 ("get",  f"{P}/encounters", "encounterBoard", "Scheduling", "Papan kerja kunjungan (status, unit, practitioner)", ["SCH-FR-013", "CLN-FR-001"], "encounter.read", None, "Encounter", {"page": 1}),
 ("get",  f"{P}/encounters/{{encounterId}}", "encounterGet", "Scheduling", "Detail kunjungan (administratif)", ["SCH-FR-013"], "encounter.read", None, "Encounter", {}),
 ("post", f"{P}/encounters/{{encounterId}}/cancel", "encounterCancel", "Scheduling", "Batalkan kunjungan (belum ada RM disahkan)", ["SCH-FR-010"], "encounter.cancel", "ReasonInput", "Encounter", {}),
 ("get",  f"{P}/queue", "queueList", "Scheduling", "Antrean poli hari ini (unitId wajib)", ["SCH-FR-008"], "queue.call", None, "QueueTicket", {"list": 1}),
 ("post", f"{P}/queue/call-next", "queueCallNext", "Scheduling", "Panggil antrean menunggu berikutnya", ["SCH-FR-008"], "queue.call", obj(["unitId"], unitId=UUID, practitionerId=UUID), "QueueTicket", {}),
 ("post", f"{P}/queue/{{ticketId}}/call", "queueCall", "Scheduling", "Panggil / panggil ulang", ["SCH-FR-008"], "queue.call", None, "QueueTicket", {}),
 ("post", f"{P}/queue/{{ticketId}}/skip", "queueSkip", "Scheduling", "Lewati antrean", ["SCH-FR-008"], "queue.call", None, "QueueTicket", {}),
 ("get",  f"{P}/queue/board", "queueBoard", "Scheduling", "Data layar TV (SSE tersedia di /queue/board/stream)", ["SCH-FR-008"], "queue.display", None, "QueueBoard", {"list": 1}),
 # Clinical
 ("get",  f"{P}/encounters/{{encounterId}}/chart", "encounterChart", "Clinical", "Layar encounter lengkap (akses dicatat audit)", ["CLN-FR-001", "CLN-FR-016", "AUD-FR-002"], "clinical.record.read", None, "EncounterChart", {}),
 ("post", f"{P}/encounters/{{encounterId}}/vitals", "vitalsRecord", "Clinical", "Rekam tanda vital (IMT otomatis)", ["CLN-FR-002"], "clinical.vitals.write", "VitalsInput", "Vital", {"list": 1, "code": "201"}),
 ("put",  f"{P}/encounters/{{encounterId}}/note", "noteSave", "Clinical", "Simpan draft SOAP (autosave)", ["CLN-FR-004", "CLN-FR-005"], "clinical.note.write", "ClinicalNoteUpdate", "ClinicalNote", {"match": 1}),
 ("put",  f"{P}/encounters/{{encounterId}}/diagnoses", "diagnosesSet", "Clinical", "Set diagnosis ICD-10 (satu primer)", ["CLN-FR-008"], "clinical.note.write", {"type": "array", "items": ref("Diagnosis")}, "Diagnosis", {"list": 1}),
 ("post", f"{P}/encounters/{{encounterId}}/procedures", "procedureAdd", "Clinical", "Tambah tindakan (masuk draft tagihan)", ["CLN-FR-009"], "clinical.note.write", "Procedure", "Procedure", {"code": "201"}),
 ("put",  f"{P}/encounters/{{encounterId}}/prescription", "prescriptionSave", "Clinical", "Simpan resep (peringatan alergi & duplikasi)", ["CLN-FR-010", "CLN-FR-011", "CLN-FR-012", "TRM-FR-005"], "clinical.prescription.write", "PrescriptionInput", "Prescription", {}),
 ("post", f"{P}/encounters/{{encounterId}}/lab-orders", "labOrderCreate", "Clinical", "Order lab ke aplikasi lab", ["CLN-FR-014"], "clinical.lab.order", "LabOrderInput", "LabOrder", {"code": "201", "idem": 1}),
 ("post", f"{P}/lab-orders/{{labOrderId}}/results", "labResultManual", "Clinical", "Input hasil manual / unggahan PDF", ["CLN-FR-015", "DOC-FR-003"], "clinical.lab.result.write", "LabResult", "LabResult", {"code": "201"}),
 ("post", f"{P}/encounters/{{encounterId}}/sign", "encounterSign", "Clinical", "Sahkan rekam medis (422 bila belum lengkap)", ["CLN-FR-017", "CLN-FR-018", "IAM-FR-016"], "clinical.note.sign", None, "SignResult", {"idem": 1, "e422": 1}),
 ("post", f"{P}/clinical-notes/{{noteId}}/addenda", "addendumCreate", "Clinical", "Addendum atas catatan yang disahkan", ["CLN-FR-019", "INT-FR-012"], "clinical.note.addendum", "AddendumInput", "Addendum", {"code": "201"}),
 ("post", f"{P}/encounters/{{encounterId}}/documents", "medicalDocumentIssue", "Document", "Terbitkan resume / surat sehat / surat sakit (PDF)", ["CLN-FR-020", "CLN-FR-021", "DOC-FR-001", "DOC-FR-002"], "clinical.document.issue", "DocumentInput", "MedicalDocument", {"code": "201", "idem": 1}),
 ("get",  f"{P}/medical-documents/{{documentId}}", "medicalDocumentGet", "Document", "Unduh ulang dokumen (berkas tersimpan)", ["DOC-FR-002"], "clinical.record.read", None, "MedicalDocument", {}),
 ("post", f"{P}/encounters/{{encounterId}}/referrals", "referralCreate", "Clinical", "Buat rujukan + surat", ["CLN-FR-022"], "clinical.document.issue", "ReferralInput", "MedicalDocument", {"code": "201"}),
 ("post", f"{P}/encounters/{{encounterId}}/follow-up", "followUpCreate", "Clinical", "Rencana kontrol → appointment", ["CLN-FR-023"], "appointment.manage", "FollowUpInput", "Appointment", {"code": "201"}),
 # Pharmacy
 ("get",  f"{P}/drugs", "drugList", "Pharmacy", "Master obat", ["PHM-FR-001"], "pharmacy.drug.read", None, "Drug", {"page": 1}),
 ("post", f"{P}/drugs", "drugCreate", "Pharmacy", "Tambah obat", ["PHM-FR-001", "PHM-FR-002"], "pharmacy.drug.manage", "Drug", "Drug", {"code": "201"}),
 ("post", f"{P}/goods-receipts", "goodsReceiptCreate", "Pharmacy", "Penerimaan barang (batch, ED, harga)", ["PHM-FR-003", "PHM-FR-004"], "pharmacy.stock.receive", "GoodsReceiptInput", "GoodsReceipt", {"code": "201", "idem": 1}),
 ("get",  f"{P}/stock", "stockList", "Pharmacy", "Saldo stok per obat/batch/lokasi", ["PHM-FR-004", "PHM-FR-019"], "pharmacy.stock.read", None, "StockLevel", {"page": 1}),
 ("get",  f"{P}/stock/alerts", "stockAlerts", "Pharmacy", "Stok minimum & mendekati kedaluwarsa", ["PHM-FR-014"], "pharmacy.stock.read", None, "StockAlert", {"list": 1}),
 ("get",  f"{P}/pharmacy/worklist", "pharmacyWorklist", "Pharmacy", "Resep masuk untuk cabang aktif", ["PHM-FR-006"], "pharmacy.dispense", None, "Prescription", {"page": 1}),
 ("post", f"{P}/prescriptions/{{prescriptionId}}/review", "prescriptionReview", "Pharmacy", "Simpan telaah resep", ["PHM-FR-007"], "pharmacy.dispense", "PrescriptionReview", "Prescription", {}),
 ("post", f"{P}/prescriptions/{{prescriptionId}}/dispense", "prescriptionDispense", "Pharmacy", "Dispensing (FEFO, parsial, tambah tagihan)", ["PHM-FR-005", "PHM-FR-008", "PHM-FR-009", "PHM-FR-011", "PHM-FR-013", "PHM-FR-019"], "pharmacy.dispense", "DispenseInput", "Dispense", {"idem": 1}),
 ("post", f"{P}/prescriptions/{{prescriptionId}}/substitutions", "substitutionRequest", "Pharmacy", "Ajukan substitusi", ["PHM-FR-010"], "pharmacy.dispense", "SubstitutionRequest", "Substitution", {"code": "201"}),
 ("post", f"{P}/substitutions/{{substitutionId}}/decision", "substitutionDecide", "Pharmacy", "Dokter setuju/tolak substitusi", ["PHM-FR-010"], "clinical.prescription.approve_substitution", "ApprovalDecision", "Substitution", {}),
 ("post", f"{P}/otc-sales", "otcSaleCreate", "Pharmacy", "Penjualan obat bebas", ["PHM-FR-012"], "pharmacy.otc.sell", "OtcSaleInput", "OtcSale", {"code": "201", "idem": 1}),
 ("post", f"{P}/stock-adjustments", "stockAdjustmentRequest", "Pharmacy", "Ajukan penyesuaian stok", ["PHM-FR-016"], "pharmacy.stock.adjust", "AdjustmentInput", "Adjustment", {"code": "201"}),
 ("post", f"{P}/stock-adjustments/{{adjustmentId}}/decision", "stockAdjustmentDecide", "Pharmacy", "Setujui/tolak penyesuaian", ["PHM-FR-016"], "pharmacy.stock.approve", "ApprovalDecision", "Adjustment", {}),
 ("post", f"{P}/stock-opnames", "opnameStart", "Pharmacy", "Mulai opname lokasi", ["PHM-FR-017"], "pharmacy.stock.opname", obj(["locationId"], locationId=UUID), "Opname", {"code": "201"}),
 ("put",  f"{P}/stock-opnames/{{opnameId}}/counts", "opnameCount", "Pharmacy", "Input hasil hitung", ["PHM-FR-017"], "pharmacy.stock.opname", "OpnameCountInput", "Opname", {}),
 ("post", f"{P}/stock-opnames/{{opnameId}}/decision", "opnameDecide", "Pharmacy", "Setujui opname (selisih → mutasi)", ["PHM-FR-017"], "pharmacy.stock.approve", "ApprovalDecision", "Opname", {}),
 # Billing
 ("get",  f"{P}/billing/worklist", "billingWorklist", "Billing", "Kunjungan siap bayar", ["BIL-FR-001"], "billing.invoice.read", None, "Encounter", {"page": 1}),
 ("get",  f"{P}/encounters/{{encounterId}}/invoice", "invoiceForEncounter", "Billing", "Draft/invoice kunjungan (harga snapshot)", ["BIL-FR-001", "BIL-FR-002", "BIL-FR-004"], "billing.invoice.read", None, "Invoice", {}),
 ("post", f"{P}/invoices/{{invoiceId}}/discounts", "invoiceDiscount", "Billing", "Diskon baris (approval bila melebihi batas)", ["BIL-FR-003"], "billing.invoice.discount", "DiscountInput", "Invoice", {"match": 1}),
 ("post", f"{P}/invoices/{{invoiceId}}/issue", "invoiceIssue", "Billing", "Terbitkan invoice", ["BIL-FR-001", "BIL-FR-002"], "billing.invoice.issue", None, "Invoice", {"match": 1, "idem": 1}),
 ("post", f"{P}/invoices/{{invoiceId}}/payments", "paymentCreate", "Billing", "Bayar tunai/debit/kartu/transfer (butuh shift terbuka)", ["BIL-FR-005", "BIL-FR-007", "BIL-FR-008", "BIL-FR-011"], "billing.payment.create", "PaymentInput", "Payment", {"code": "201", "idem": 1}),
 ("post", f"{P}/invoices/{{invoiceId}}/qris", "qrisChargeCreate", "Billing", "Buat QR dinamis", ["BIL-FR-006"], "billing.payment.create", "QrisChargeInput", "QrisCharge", {"code": "201", "idem": 1}),
 ("get",  f"{P}/qris/{{chargeId}}", "qrisChargeGet", "Billing", "Status QR (polling/SSE)", ["BIL-FR-006"], "billing.payment.create", None, "QrisCharge", {}),
 ("post", "/api/integrations/payment-gateway/callback", "paymentGatewayCallback", "Billing", "Callback provider (verifikasi signature, idempoten)", ["BIL-FR-006"], None, "GatewayCallback", None, {"public": 1, "code": "200", "webhook": 1}),
 ("post", f"{P}/invoices/{{invoiceId}}/void-requests", "invoiceVoidRequest", "Billing", "Ajukan void", ["BIL-FR-009"], "billing.invoice.void.request", "VoidInput", "VoidRequest", {"code": "201"}),
 ("post", f"{P}/void-requests/{{voidRequestId}}/decision", "invoiceVoidDecide", "Billing", "Setujui/tolak void", ["BIL-FR-009"], "billing.invoice.void.approve", "ApprovalDecision", "VoidRequest", {}),
 ("post", f"{P}/refunds", "refundRequest", "Billing", "Ajukan refund", ["BIL-FR-010"], "billing.refund.request", "RefundInput", "Refund", {"code": "201", "idem": 1}),
 ("post", f"{P}/refunds/{{refundId}}/decision", "refundDecide", "Billing", "Setujui/tolak refund (≠ pengaju)", ["BIL-FR-010"], "billing.refund.approve", "ApprovalDecision", "Refund", {}),
 ("post", f"{P}/cashier-shifts", "shiftOpen", "Billing", "Buka shift", ["BIL-FR-011"], "billing.shift.manage", "ShiftOpenInput", "Shift", {"code": "201"}),
 ("get",  f"{P}/cashier-shifts/current", "shiftCurrent", "Billing", "Shift aktif & total per metode", ["BIL-FR-011"], "billing.shift.manage", None, "Shift", {}),
 ("post", f"{P}/cashier-shifts/{{shiftId}}/close", "shiftClose", "Billing", "Tutup shift (hitung selisih)", ["BIL-FR-011"], "billing.shift.manage", "ShiftCloseInput", "Shift", {}),
 ("get",  f"{P}/receivables", "receivableList", "Billing", "Piutang penjamin", ["BIL-FR-013"], "billing.receivable.read", None, "Receivable", {"page": 1}),
 ("post", f"{P}/receivables/{{receivableId}}/payments", "receivablePay", "Billing", "Catat pelunasan piutang", ["BIL-FR-013"], "billing.receivable.manage", "ReceivablePaymentInput", "Receivable", {"idem": 1}),
 ("get",  f"{P}/billing/reconciliation/qris", "qrisReconciliation", "Billing", "Rekonsiliasi QRIS vs settlement", ["BIL-FR-012"], "billing.reconcile", None, obj(chargeId=UUID, issue=S(), amount=MONEY), {"list": 1}),
 # Integration
 ("put",  f"{P}/integrations/satusehat", "satusehatConfigure", "Integration", "Simpan kredensial (ke Secret Manager)", ["INT-FR-001"], "integration.manage", "IntegrationConnectionInput", "IntegrationConnection", {}),
 ("post", f"{P}/integrations/satusehat/test", "satusehatTest", "Integration", "Uji koneksi", ["INT-FR-001"], "integration.manage", None, "ConnectionTest", {}),
 ("post", f"{P}/integrations/satusehat/sync-master", "satusehatSyncMaster", "Integration", "Sinkron Organization/Location/Practitioner", ["INT-FR-002"], "integration.manage", None, None, {"code": "202"}),
 ("get",  f"{P}/integrations/satusehat/summary", "satusehatSummary", "Integration", "Ringkasan terkirim/tertunda/gagal per hari", ["INT-FR-010", "INT-FR-004", "INT-FR-005"], "integration.read", None, "SyncSummary", {"list": 1}),
 ("get",  f"{P}/integrations/satusehat/records", "satusehatRecords", "Integration", "Daftar status per resource & error", ["INT-FR-008", "INT-FR-009", "INT-FR-010", "INT-FR-003"], "integration.read", None, "SyncRecord", {"page": 1}),
 ("post", f"{P}/integrations/satusehat/records/{{recordId}}/retry", "satusehatRetry", "Integration", "Kirim ulang (teraudit, idempoten)", ["INT-FR-009"], "integration.manage", None, "SyncRecord", {}),
 ("get",  f"{P}/integrations/satusehat/reconciliation", "satusehatReconciliation", "Integration", "Kunjungan disahkan yang belum terkirim", ["INT-FR-011"], "integration.read", None, "ReconciliationRow", {"page": 1}),
 # Reports
 ("get",  f"{P}/dashboard/today", "dashboardToday", "Report", "Dashboard harian", ["RPT-FR-009"], "report.dashboard.read", None, "Dashboard", {}),
 ("get",  f"{P}/reports/visits", "reportVisits", "Report", "Kunjungan per cabang/poli/dokter/penjamin", ["RPT-FR-001"], "report.operational.read", None, "ReportResult", {}),
 ("get",  f"{P}/reports/top-diagnoses", "reportTopDiagnoses", "Report", "10 besar diagnosis", ["RPT-FR-002"], "report.clinical.read", None, "ReportResult", {}),
 ("get",  f"{P}/reports/revenue", "reportRevenue", "Report", "Pendapatan per layanan/metode/penjamin", ["RPT-FR-003"], "report.finance.read", None, "ReportResult", {}),
 ("get",  f"{P}/reports/cashier-closing", "reportCashierClosing", "Report", "Closing kasir", ["RPT-FR-004"], "report.finance.read", None, "ReportResult", {}),
 ("get",  f"{P}/reports/stock", "reportStock", "Report", "Stok & mutasi", ["RPT-FR-005"], "report.pharmacy.read", None, "ReportResult", {}),
 ("get",  f"{P}/reports/controlled-drugs", "reportControlledDrugs", "Report", "Narkotika/psikotropika", ["RPT-FR-006", "PHM-FR-019"], "report.pharmacy.controlled", None, "ReportResult", {}),
 ("get",  f"{P}/reports/receivables", "reportReceivables", "Report", "Umur piutang", ["RPT-FR-007"], "report.finance.read", None, "ReportResult", {}),
 ("get",  f"{P}/reports/anomalies", "reportAnomalies", "Report", "Transaksi tidak wajar", ["BIL-FR-016"], "report.finance.audit", None, "ReportResult", {}),
 ("post", f"{P}/reports/{{reportCode}}/exports", "reportExport", "Report", "Export Excel/CSV/PDF (watermark, asinkron)", ["RPT-FR-008"], "report.export", "ExportRequest", "ExportJob", {"code": "202"}),
]

# ---------------------------------------------------------------------------
paths = {}
for method, path, opid, tag, summary, reqs, perm, body, resp, o in ops:
    op = {"operationId": opid, "tags": [tag], "summary": summary, "x-requirements": reqs}
    if perm: op["x-permission"] = perm
    params = [{"$ref": f"#/components/parameters/{n}"} for n in __import__("re").findall(r"\{(\w+)\}", path)]
    if o.get("page"): params += [{"$ref": "#/components/parameters/cursor"}, {"$ref": "#/components/parameters/limit"}]
    if o.get("idem"): params.append({"$ref": "#/components/parameters/IdempotencyKey"})
    if o.get("match"): params.append({"$ref": "#/components/parameters/IfMatch"})
    if params: op["parameters"] = params
    if o.get("public"): op["security"] = [] if not o.get("webhook") else [{"gatewaySignature": []}]
    elif o.get("platform"): op["security"] = [{"platformSession": []}]
    if body is not None:
        b = ref(body) if isinstance(body, str) else body
        if o.get("multipart"):
            op["requestBody"] = {"required": True, "content": {"multipart/form-data": {"schema": obj(["file"], file=b, dryRun=BOOL)}}}
        elif o.get("upload"):
            op["requestBody"] = {"required": True, "content": {"text/csv": {"schema": b},
                                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {"schema": b}}}
        else:
            op["requestBody"] = {"required": True, "content": {"application/json": {"schema": b}}}
    code = o.get("code", "200")
    if resp is None:
        if o.get("file"):
            r = {"description": "Berkas", "content": {"text/csv": {"schema": {"type": "string", "format": "binary"}},
                 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {"schema": {"type": "string", "format": "binary"}}}}
        elif o.get("binary"):
            r = {"description": "Berkas", "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}
        else:
            r = {"description": {"302": "Redirect", "204": "Berhasil", "202": "Diterima untuk diproses", "200": "Diterima", "201": "Dibuat"}.get(code, "OK")}
    else:
        rs = ref(resp) if isinstance(resp, str) else resp
        if o.get("page"):
            rs = obj(["data", "page"], data={"type": "array", "items": rs}, page=ref("PageInfo"))
        elif o.get("list"):
            rs = {"type": "array", "items": rs}
        r = {"description": "OK", "content": {"application/json": {"schema": rs}}}
    responses = {code: r}
    if code == "302": responses[code]["headers"] = {"Location": {"schema": S(format="uri")}}
    responses["400"] = {"$ref": "#/components/responses/BadRequest"}
    if not o.get("public") or o.get("webhook"): responses["401"] = {"$ref": "#/components/responses/Unauthorized"}
    if perm or o.get("forbidden"): responses["403"] = {"$ref": "#/components/responses/Forbidden"}
    if "{" in path or o.get("notfound"): responses["404"] = {"$ref": "#/components/responses/NotFound"}
    if method in ("post", "put") and not o.get("public"): responses["409"] = {"$ref": "#/components/responses/Conflict"}
    if o.get("match"): responses["412"] = {"$ref": "#/components/responses/PreconditionFailed"}
    if o.get("e422"): responses["422"] = {"description": "Validasi pengesahan gagal", "content": {"application/problem+json": {"schema": {"allOf": [ref("Problem"), ref("SignValidationError")]}}}}
    if path.startswith(f"{P}/auth") or path.startswith(f"{PP}/auth"): responses["429"] = {"$ref": "#/components/responses/TooManyRequests"}
    op["responses"] = responses
    paths.setdefault(path, {})[method] = op

def pparam(name, desc):
    return {"name": name, "in": "path", "required": True, "description": desc, "schema": S() if name in ("token", "entity", "feature", "reportCode") else UUID}
path_params = sorted({n for _, p, *_ in ops for n in __import__("re").findall(r"\{(\w+)\}", p)})
parameters = {n: pparam(n, n) for n in path_params}
parameters.update({
  "cursor": {"name": "cursor", "in": "query", "required": False, "schema": S(), "description": "Cursor dari page.nextCursor"},
  "limit": {"name": "limit", "in": "query", "required": False, "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
  "IdempotencyKey": {"name": "Idempotency-Key", "in": "header", "required": True, "schema": S(minLength=16, maxLength=100),
                     "description": "Kunci unik per aksi; permintaan ulang dengan kunci sama mengembalikan hasil pertama"},
  "IfMatch": {"name": "If-Match", "in": "header", "required": True, "schema": S(), "description": "Versi objek (ETag) untuk optimistic locking (GEN-FR-007)"},
})
def problem(desc): return {"description": desc, "content": {"application/problem+json": {"schema": ref("Problem")}}}
doc = {
  "openapi": "3.1.0",
  "info": {"title": "ClinicRME API", "version": "0.1.0-draft",
           "description": "Draft kontrak API Stage 2 (design-first, ADR-0008). Setiap operasi memuat `x-requirements` (ID SRS) dan `x-permission`. "
                          "Semua endpoint `/api/v1` beroperasi dalam konteks tenant & cabang aktif dari sesi; tenant tidak pernah dikirim di body.",
           "license": {"name": "Proprietary", "identifier": "LicenseRef-Proprietary"}},
  "servers": [{"url": "https://{tenant}.clinicrme.id", "variables": {"tenant": {"default": "demo"}}}, {"url": "https://staging.clinicrme.id"}],
  "security": [{"session": []}],
  "tags": [{"name": t, "description": t} for t in dict.fromkeys(op[3] for op in ops)],
  "paths": paths,
  "components": {
    "securitySchemes": {
      "session": {"type": "apiKey", "in": "cookie", "name": "crme_session", "description": "Cookie sesi HttpOnly (ADR-0003)"},
      "gatewaySignature": {"type": "apiKey", "in": "header", "name": "X-Signature", "description": "Signature HMAC dari payment gateway"},
      "platformSession": {"type": "apiKey", "in": "cookie", "name": "crme_psession",
                          "description": "Cookie sesi konsol platform, hanya di host admin.<domain> (CR-0001)"}},
    "parameters": parameters,
    "responses": {"BadRequest": problem("Input tidak valid"), "Unauthorized": problem("Belum login / sesi tidak berlaku"),
                  "Forbidden": problem("Tidak memiliki permission"), "NotFound": problem("Tidak ditemukan (termasuk resource tenant lain)"),
                  "Conflict": problem("Konflik status / data immutable / duplikat"), "PreconditionFailed": problem("Versi data sudah berubah"),
                  "TooManyRequests": problem("Terlalu banyak percobaan")},
    "schemas": schemas}}
with open(sys.argv[1], "w") as f:
    yaml.safe_dump(doc, f, sort_keys=False, allow_unicode=True, width=140)
print(len(ops), "operasi,", len(paths), "path,", len(schemas), "skema")
