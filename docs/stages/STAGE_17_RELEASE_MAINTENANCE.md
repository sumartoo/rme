# Stage 17 — Production Release & Maintenance

| | |
|---|---|
| Phase | F — Produksi |
| Status | Belum dimulai |
| Prasyarat | Stage 16 disetujui |

## 1. Tujuan

Menjalankan aplikasi secara berkelanjutan, aman, dan terkendali setelah go-live.

## 2. Ruang Lingkup

- Rilis bertahap & rollback plan.
- Monitoring kesehatan aplikasi, keamanan, dan biaya.
- Penanganan tiket & insiden.
- Patch keamanan & pembaruan dependency.
- Backup & uji pemulihan berkala.
- Evaluasi performa & kapasitas.
- Pengelolaan Change Request.
- Evaluasi regulasi & interoperabilitas.
- Perencanaan versi berikutnya.

## 3. Rancangan

### 3.1 Strategi Rilis

| Aspek | Usulan |
|---|---|
| Versi | Semantic versioning (`MAJOR.MINOR.PATCH`) |
| Deploy | Cloud Run traffic splitting: 10% → 50% → 100% |
| Fitur baru | Feature flag per tenant; aktifkan bertahap |
| Migrasi DB | Expand → migrate → contract (backward compatible antar dua versi aplikasi) |
| Rollback | Kembalikan traffic ke revisi sebelumnya; migrasi bersifat additive sehingga aman |
| Jendela rilis | Di luar jam praktik klinik |
| Android | Staged rollout Play Store; force-update untuk versi tidak aman |

### 3.2 Release Checklist

- [ ] Semua CR yang masuk rilis disetujui.
- [ ] CI hijau, regression test lulus.
- [ ] Migrasi diuji di staging dengan salinan skema produksi.
- [ ] Security scan tanpa temuan kritis.
- [ ] Release notes & dokumentasi diperbarui.
- [ ] Rollback plan tertulis.
- [ ] Persetujuan Project Owner.

### 3.3 Operasional

| Proses | Target usulan |
|---|---|
| Severity 1 (sistem down / kebocoran data) | Respons ≤ 30 menit, 24/7 |
| Severity 2 (fitur kritis terganggu) | Respons ≤ 2 jam jam kerja |
| Patch keamanan kritis | ≤ 7 hari |
| Update dependency rutin | Bulanan |
| Uji restore | Bulanan |
| Review biaya & kapasitas | Bulanan |
| Review regulasi & SATUSEHAT | Kuartalan |
| Verifikasi audit chain | Harian (otomatis) |

## 4. Deliverable

`RELEASE_PROCESS.md`, `RELEASE_CHECKLIST.md`, `SUPPORT_AND_SLA.md`, `CHANGE_REQUEST_LOG.md`, release notes per versi, laporan operasional bulanan.

## 5. Gate (berlaku per rilis)

Setiap rilis memenuhi release checklist dan persetujuan yang ditetapkan.

## 6. Open Decision

- **OD-052** — SLA dukungan per paket langganan.
- **OD-053** — Kebijakan versi Android minimum yang didukung.
