# ReceiptMatch Product Requirements

Status: DEC-01 through DEC-11 and the R-02 subdivision are approved. Subphase 3.1 is authorized as [REC-2](https://wigtertainment.atlassian.net/browse/REC-2); later subphases require separate approval. The decision register is in [Open Questions](OPEN-QUESTIONS.md).

## Problem and users

Small businesses, freelancers, and individuals periodically assemble bank statements and supporting documents for their accountant. Manually locating the evidence for each individual transaction is slow and error-prone, especially across multiple accounts and mixed document types.

ReceiptMatch should reduce this work through a local desktop workflow that suggests explainable matches and lets users review and correct them. The matching unit is an individual bank transaction and its supporting documents, not an entire statement or another invoice.

## Goals

- Reduce manual searching while preserving user control over uncertain results.
- Complete a useful workflow from local imports to approved document copies, a CSV reconciliation report, and a reconciliation summary.
- Preserve original files and reconciliation progress.
- Operate on Windows and Linux without required accounts, cloud services, or AI.

## Core workflow

1. Import one or more PDF bank statements, including statements from different accounts.
2. Extract and normalize individual transactions while retaining their account and statement association.
3. Select a local folder containing mixed supporting documents and analyze them, preferring embedded text and using local OCR when necessary.
4. Inspect suggested matches, their explanations, and reliable, uncertain, or unmatched results.
5. Assign, correct, or remove associations, including multiple documents for one transaction; review suggestions and approve associations individually or in batches.
6. Save progress locally and resume it later.
7. Review the reconciliation summary and export renamed copies of approved documents using associated transaction information, together with a CSV reconciliation report.

Initial providers are Revolut and Airwallex in EUR, with PDF statements and PDF/PNG/JPEG supporting documents. English UI/OCR, Ubuntu as the Linux target, explicit saving, the conservative matching/approval/duplicate rules, and export defaults are approved under DEC-06 through DEC-11. Concrete PDF layouts, reference/status details, and the exact export contract remain partly open; see [Open Questions](OPEN-QUESTIONS.md).

## Functional requirements

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-01 | Import one or multiple PDF bank statements from one or multiple accounts (DEC-01). | Representative supported text-based and scanned PDF layouts produce individual transactions associated with the correct source statement and account; unsupported or unreadable inputs are identified. Universal PDF layout support is not implied. |
| FR-02 | Extract and normalize individual transactions, preferring embedded text and using local OCR when necessary (DEC-01, DEC-02). | Supported PDF fixtures retain amount, currency, dates and available counterparty/reference information; failed, uncertain, and unavailable extraction is visible without invented values. |
| FR-03 | Analyze a selected local folder of mixed PDF/PNG/JPEG supporting documents. | Supported invoices, receipts, credit notes, and other agreed layouts coexist without prior sorting; individual analysis failures are visible (DEC-06). |
| FR-04 | Extract document dates, amounts, currencies, merchants, and references, preferring embedded text and using local OCR when necessary (DEC-02). | Representative text and scanned-document fixtures produce available supported fields; extraction failures, uncertainty, and missing values are visible without invented financial data. No cloud OCR or external AI API is required. |
| FR-05 | Produce deterministic, explainable transaction-to-document suggestions under DEC-08. | Identical normalized inputs/rules produce identical suggestions. Exact amount, compatible direction and equal currency are required; ±7-day date proximity is evidence. Reliable suggestions require a unique matching reference and consistent amount/currency without conflicts. |
| FR-06 | Distinguish reliable, uncertain, and unmatched results while keeping confidence separate from user approval (DEC-03). | Confidence does not imply approval; suggestions, including reliable ones, remain reviewable and do not silently become final accounting decisions. |
| FR-07 | Allow manual assignment, correction, and removal of matches. | A user can inspect and change a transaction's document association and see the resulting state. |
| FR-08 | Support manually associating multiple documents with one transaction (DEC-05). | A user can assign and remove group members and review relevant amount differences. Future one-document-to-many-transactions associations must remain feasible; full partial-payment UI and automatic split allocation are outside the MVP. |
| FR-09 | Create, open, and explicitly save local workspaces (DEC-07). | Warn before discarding unsaved work; cancelled/failed operations retain current state. Saved transactions, extracted information, associations, confidence, and separate approval/reconciliation states survive reopening. Unrelated/corrupt workspace files are rejected without modification. |
| FR-10 | Export renamed copies of approved associations using transaction information (DEC-03, DEC-04, DEC-11). | Only approved associations produce copies in a separate destination's `documents/`; filenames use booking date, counterparty, currency, amount, and transaction ID. Originals and existing output files remain unchanged. |
| FR-11 | Show a reconciliation summary. | Matched, unmatched, unresolved, and manually processed transactions remain visible under the agreed status model; confidence and approval are distinguishable, including any defined status overlaps. |
| FR-12 | Allow review and batch approval (DEC-03, DEC-09). | All suggestions remain reviewable; reviewed associations can be approved together. Relevant changes revoke affected approvals; unchanged reanalysis preserves manual work. Confidence never grants approval. |
| FR-13 | Export a CSV reconciliation report (DEC-04, DEC-11). | UTF-8/comma `reconciliation.csv` includes open transactions, references, statuses, confidence, approval, and export outcomes. Existing files are not overwritten; exact columns/row structure remain Q-07. |

FR-02 describes required information semantically; PDF-specific field mappings and date semantics need agreement under Q-01 and Q-04. FR-08 requires future many-to-many readiness without prescribing a data model or a full MVP partial-payment workflow. Remaining group behavior is Q-03; approval changes after edits/reanalysis are Q-05/Q-06.

## Non-functional requirements

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| NFR-01 | Preserve original statements and supporting documents. | Successful and failed import, analysis, matching, save, and export operations neither alter nor delete original files. |
| NFR-02 | Keep financial data local by default and support the core workflow offline. | Import through export works without network access after installation and any explicitly agreed local resource setup; no mandatory account, external service, or AI integration is required. |
| NFR-03 | Support Windows and Linux desktop use, initially targeting Ubuntu on Linux. | The agreed core acceptance scenario can be completed on both target platforms; supported Windows/Ubuntu releases and architectures remain Q-09. |
| NFR-04 | Prioritize financial correctness and visible uncertainty. | Monetary values and currencies survive normalization, persistence, and export without unintended rounding or currency substitution; extraction conflicts and operation failures are visible. |
| NFR-05 | Keep the architecture modular, extensible, and reasonably simple. | Later architecture review explains responsibilities and trade-offs, preserves future statement-format extensibility, and avoids association constraints that hinder future many-to-many support (DEC-01, DEC-05), without implementing deferred workflows. |
| NFR-06 | Prefer mature libraries for common technical capabilities. | Later dependency choices assess maintenance, security, performance, documentation, tests, and license compatibility; architecture and product behavior are derived from ReceiptMatch's requirements. |

Performance targets and reference workload remain Q-09. Exact amount/same-currency matching and ±7-day date evidence are approved; no numeric confidence score or processing limit is selected.

## Proposed MVP

- A local reconciliation workspace supporting the complete core workflow.
- Revolut/Airwallex EUR PDF statements with representative text/scanned layouts and PDF/PNG/JPEG supporting documents; concrete layouts still need examples.
- Required local English OCR where necessary, preferring embedded text, with visible extraction failures and uncertainty.
- Multiple statements and accounts, mixed supported document types, and document field extraction.
- Explainable deterministic suggestions, review of all suggestions, separate confidence/approval, manual correction, and batch approval after review.
- Manual grouping of multiple documents for one transaction.
- Local save/resume, approved-association document-copy export, a CSV reconciliation report, and a consistent summary including unmatched/unresolved work.
- Verification on Windows and Linux with representative agreed examples.

Local English OCR and the input formats are approved. Q-01/Q-02 still define representative layouts and extraction acceptance fixtures; universal PDF support is not promised.

## Explicit exclusions from the proposed MVP

- Bank connections, payment execution, bookkeeping, tax calculations, and accountant-system integrations.
- Invoice-to-invoice matching or whole-statement comparison as the primary workflow.
- Mandatory cloud processing, online accounts, collaboration, or AI; optional local AI is a possible future topic.
- CSV, CAMT, and other bank statement import formats (DEC-01); CSV report export remains required.
- Full partial-payment workflows and their dedicated UI, and automatic split-payment allocation (DEC-05). Future many-to-many readiness remains required.
- Automatic discovery of document groups and automatic foreign-exchange or fee allocation. Remaining manual group/financial behavior is decided under Q-03 and Q-04.
- Universal support for every bank, document format, language, or layout.
- Document-copy export of unapproved associations, regardless of confidence (DEC-03). Batch approval after review is supported.

## MVP acceptance

Use representative text-based and scanned PDF statement layouts and supported mixed document fixtures, covering multiple statements/accounts, failed/uncertain extraction, ambiguous candidates, unmatched work, and several documents for one transaction. On both platforms, verify FR-01 through FR-13 and NFR-01 through NFR-04 through import, embedded-text/local-OCR extraction, review, correction, batch approval, save/reopen, summary, and export. Confidence must not imply approval; only approved associations produce document copies, while the CSV report also represents unmatched/unresolved work. Originals remain unchanged. NFR-05 and NFR-06, including future format/many-to-many readiness, are assessed during the separately approved architecture/dependency review.

Product acceptance also requires resolving blocking questions and confirming or revising the proposed safeguards and assumptions in [Open Questions](OPEN-QUESTIONS.md). Acceptance evidence and workload targets must be agreed before claiming MVP completion.

## Assumptions and risks

- The user can provide authorized local statement/document examples; synthetic fixtures can cover additional cases. No production financial data should be required for planning.
- OCR quality, heterogeneous statement layouts, missing references, refunds, duplicate inputs, and currency differences may increase manual review.
- A high-quality match suggestion is not proof of accounting correctness; classification must remain explainable and reviewable.
- Electron/Angular/TypeScript and SQLite are the approved baseline, supported by the accepted synthetic architecture validation; real-layout and release readiness remain separate acceptance topics.
- Duplicate/reanalysis and no-overwrite principles are approved; detailed source-change, conflict, and recovery behavior remains in the decision register.

Related documents: [User Stories](USER-STORIES.md), [Open Questions](OPEN-QUESTIONS.md), [MVP Roadmap](../planning/MVP-ROADMAP.md), [Backlog Draft](../planning/BACKLOG-DRAFT.md).
