# Change Request Policy — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — DRAFT untuk persetujuan |
| Tanggal | 3 November 2026 |

## 1. Kapan CR Diperlukan

CR wajib untuk setiap perubahan terhadap artefak yang sudah **APPROVED**:

- Scope (SCOPE.md), roadmap, atau urutan stage
- Requirement, use case, workflow, acceptance criteria yang disetujui
- Arsitektur, ADR berstatus Accepted, skema database yang sudah dirilis, kontrak API publik
- Penambahan layanan atau dependensi berbayar

CR **tidak** diperlukan untuk: perbaikan typo, klarifikasi yang tidak mengubah makna, atau perbaikan defect agar sesuai requirement yang sudah disetujui.

## 2. Alur

```
Diajukan → Analisis dampak → Keputusan PO → (Disetujui) Dijadwalkan → Diimplementasikan → Diverifikasi → Ditutup
                                         └→ (Ditolak / Ditunda) dicatat
```

| Langkah | Pelaku | Output |
|---|---|---|
| Ajukan | Siapa pun | File CR dari template |
| Analisis dampak | Tim pengembang | Dampak ke scope, jadwal, biaya, risiko, keamanan, regulasi, requirement & test terkait |
| Putuskan | Project Owner | Disetujui / Ditolak / Ditunda |
| Implementasi | Tim | Perubahan + update RTM + test |
| Verifikasi & tutup | Tim + PO | Bukti, status Ditutup |

## 3. Prioritas

| Prioritas | Contoh | Penanganan |
|---|---|---|
| Darurat | Celah keamanan, perubahan regulasi berlaku segera | Boleh dikerjakan sebelum keputusan formal, PO diberi tahu dalam 1×24 jam, CR dilengkapi setelahnya |
| Tinggi | Kebutuhan klinik pilot yang menghambat | Diputuskan di review berikutnya |
| Normal | Peningkatan | Dijadwalkan |

## 4. Penyimpanan

- File: `docs/00-governance/change-requests/CR-NNNN-judul.md`
- Ringkasan: `docs/00-governance/CHANGE_REQUEST_LOG.md`

## 5. Template CR

```markdown
# CR-NNNN — <judul>

| | |
|---|---|
| Diajukan oleh | |
| Tanggal | |
| Prioritas | Darurat / Tinggi / Normal |
| Status | Diajukan / Dianalisis / Disetujui / Ditolak / Ditunda / Selesai |

## Perubahan yang diminta
## Alasan
## Artefak terdampak
(requirement ID, ADR, tabel, API, stage)
## Analisis dampak
- Scope:
- Jadwal:
- Biaya:
- Keamanan & privasi:
- Regulasi:
- Test yang perlu ditambah/diubah:
## Alternatif
## Keputusan PO
| Keputusan | Tanggal | Catatan |
```
