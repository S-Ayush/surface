---
paths:
  - 'docs/**'
---

# Docs

- **Write in plain, direct English.** Keep sentences short, and use the same term for the same concept everywhere (check `docs/03-domain/glossary.md`).
- **Specs:**
  - Status is Draft → Accepted. Acceptance criteria are numbered `AC-n` and edge cases `E-n`, and each must be testable.
  - Resolved questions move to the "Decisions" table with a date.
  - Once a spec is Accepted, change it only to reflect a deliberate decision, and say what changed.
- **Plans:**
  - Each slice is `### Sn: Title · S|M|L`.
  - When a slice is done, add `· ✅ Done YYYY-MM-DD` to its heading and an "As built" blockquote covering versions, deviations from the plan or spec, and notes for later slices.
- **ADRs:**
  - Never edit the decision of an accepted ADR. Write a new ADR that supersedes it, and change only the old one's status line to "Superseded by ADR-NNNN".
  - Add every new ADR to `adr/README.md`.
- **Cross-references:** use relative links. When renaming a heading, search for links to it.
- **Formatting:** Prettier does not format `docs/` (wide tables), so keep tables aligned by hand where practical.
