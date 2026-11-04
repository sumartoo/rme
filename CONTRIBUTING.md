# Contributing — ClinicRME SaaS

Kode & standar: [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) · Strategi uji: [docs/05-testing/TEST_STRATEGY.md](docs/05-testing/TEST_STRATEGY.md) · Lingkungan: [docs/02-architecture/ENVIRONMENTS.md](docs/02-architecture/ENVIRONMENTS.md)

## Alur Kerja

1. **Trunk-based.** `main` is always deployable.
   - Work in a short branch (`feat/IAM-FR-006-undangan`, `fix/...`) that lives at most a few days.
2. **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) and they mention the requirement ID.
   - Example: `feat(iam): undangan user via email (IAM-FR-006)`.
   - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `security`.
3. **Pull requests** to `main`:
   - Fill in the PR template.
   - Every CI job must pass (`ci`, `security`).
   - At least **one review**. For as long as the PO is the only developer, this is a self-review against the checklist, recorded in the PR.
4. **Merge** with *squash*. The commit title follows rule 2.
5. Changes to an **APPROVED** artifact (requirements, ADRs, contracts, released schema) require a CR (`docs/00-governance/CHANGE_REQUEST_POLICY.md`).

## Sebelum Push

```bash
pnpm lint && pnpm typecheck && pnpm test
TEST_PG_ADMIN_URL=postgres://… pnpm test:integration   # if you touched api/libs/db
```

## Pengaturan Repository GitHub (dilakukan PO sekali)

- **Branch protection on `main`:**
  - require PR, require status checks `ci` and `security`, require linear history;
  - block force-push and branch deletion.
- **Settings → Actions:**
  - "Read repository contents" as the default `GITHUB_TOKEN` permission;
  - fork PRs need approval before running.
- **Dependabot:** alerts and security updates on (configuration in `.github/dependabot.yml`).
- **Secret scanning bawaan GitHub** untuk repo privat memerlukan lisensi berbayar (GitHub Secret Protection) — tidak diaktifkan; penggantinya gitleaks di workflow `security` (seluruh riwayat git).
