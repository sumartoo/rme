# Glossary — ClinicRME SaaS

| Istilah | Arti |
|---|---|
| **Addendum** | Catatan tambahan untuk mengoreksi atau melengkapi rekam medis yang sudah disahkan, tanpa mengubah catatan asli |
| **ADR** | Architecture Decision Record — dokumen keputusan arsitektur |
| **Break-glass** | Akses darurat berbatas waktu, wajib alasan, dan teraudit |
| **Cabang** | Lokasi pelayanan dalam satu tenant |
| **Co-pay** | Bagian biaya yang ditanggung pasien di luar porsi penjamin |
| **CR** | Change Request — permintaan perubahan atas artefak yang sudah disetujui |
| **DPIA** | Data Protection Impact Assessment — penilaian dampak pelindungan data pribadi |
| **Encounter / Kunjungan** | Satu kali pelayanan pasien di klinik, dari pendaftaran sampai selesai |
| **FEFO** | First Expired, First Out — batch dengan kedaluwarsa terdekat dikeluarkan lebih dulu |
| **FIFO** | First In, First Out — batch yang masuk lebih dulu dikeluarkan lebih dulu |
| **FHIR** | Fast Healthcare Interoperability Resources — standar HL7 untuk pertukaran data kesehatan |
| **FKTP** | Fasilitas Kesehatan Tingkat Pertama (dalam konteks BPJS) |
| **Gate** | Titik persetujuan di akhir setiap stage |
| **HET** | Harga Eceran Tertinggi |
| **HNA** | Harga Netto Apotek |
| **ICD-10** | Klasifikasi internasional penyakit, revisi ke-10, untuk kode diagnosis |
| **ICD-9-CM** | Klasifikasi tindakan/prosedur medis |
| **IHS number** | Nomor identitas pasien/praktisi di platform SATUSEHAT |
| **Idempotency** | Sifat operasi yang menghasilkan efek sama walau dijalankan berulang |
| **KFA** | Kamus Farmasi dan Alat Kesehatan (referensi obat SATUSEHAT) |
| **Klinik Pratama** | Klinik yang menyelenggarakan pelayanan medik dasar |
| **Klinik Utama** | Klinik yang menyelenggarakan pelayanan medik spesialistik |
| **LJT** | Lanjutan — requirement yang dikerjakan setelah pilot |
| **Maker–checker** | Kontrol di mana pengaju dan penyetuju harus orang berbeda |
| **MFA / TOTP** | Multi-factor authentication / Time-based One-Time Password (aplikasi authenticator) |
| **MPI** | Master Patient Index — indeks identitas pasien tunggal per tenant |
| **MRN** | Medical Record Number — nomor rekam medis |
| **MVP** | Minimum Viable Product — requirement wajib untuk pilot |
| **OD** | Open Decision — keputusan yang belum diambil |
| **Outbox** | Pola penyimpanan event dalam transaksi yang sama dengan data, lalu diproses worker |
| **Pengesahan** | Penandatanganan rekam medis oleh dokter penanggung jawab; setelahnya catatan terkunci |
| **Penjamin** | Pihak yang menanggung biaya: Umum (pasien sendiri), Asuransi, Perusahaan, BPJS |
| **PHI** | Protected Health Information — informasi kesehatan yang dapat mengidentifikasi individu |
| **PO** | Project Owner |
| **PPDP** | Pejabat/Petugas Pelindungan Data Pribadi (DPO) |
| **Praktik Mandiri** | Praktik dokter / dokter gigi perorangan |
| **QRIS** | Quick Response Code Indonesian Standard |
| **RLS** | Row-Level Security — pembatasan baris data di PostgreSQL berdasarkan tenant |
| **RME** | Rekam Medis Elektronik |
| **RPO / RTO** | Recovery Point / Time Objective — batas kehilangan data / lama pemulihan |
| **RTM** | Requirement Traceability Matrix |
| **SATUSEHAT** | Platform integrasi data kesehatan nasional Kemenkes |
| **SIP / STR** | Surat Izin Praktik / Surat Tanda Registrasi tenaga kesehatan |
| **SOAP** | Subjective, Objective, Assessment, Plan — format catatan klinis |
| **Snapshot tarif** | Salinan harga saat transaksi yang tidak berubah walau tarif master diubah |
| **Telaah resep** | Pemeriksaan resep oleh farmasi: administratif, farmasetik, klinis |
| **Tenant** | Satu pelanggan SaaS (klinik / grup klinik / praktik) dengan data terisolasi |
| **Void** | Pembatalan dokumen transaksi dengan jejak, tanpa menghapus |
