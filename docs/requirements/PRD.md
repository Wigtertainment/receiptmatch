# ReceiptMatch Product Requirements

Status: Phase 1 proposal for review. This document does not authorize implementation or finalize the architecture.

## Problem and users

Small businesses, freelancers, and individuals periodically assemble bank statements and supporting documents for their accountant. Manually locating the evidence for each individual transaction is slow and error-prone, especially across multiple accounts and mixed document types.

ReceiptMatch should reduce this work through a local desktop workflow that suggests explainable matches and lets users review and correct them. The matching unit is an individual bank transaction and its supporting documents, not an entire statement or another invoice.

## Goals

- Reduce manual searching while preserving user control over uncertain results.
- Complete a useful workflow from local imports to renamed document copies and a reconciliation summary.
- Preserve original files and reconciliation progress.
- Operate on Windows and Linux without required accounts, cloud services, or AI.

## Core workflow

1. Import one or more bank statements, including statements from different accounts.
2. Extract and normalize individual transactions while retaining their account and statement association.
3. Select a local folder containing mixed supporting documents and analyze them.
4. Inspect suggested matches, their explanations, and reliable, uncertain, or unmatched results.
5. Assign, correct, or remove matches, including multiple documents for one transaction.
6. Save progress locally and resume it later.
7. Review the reconciliation summary and export renamed copies of matched documents using associated transaction information.

Input-format coverage, matching classification rules, and export naming remain open decisions; see [Open Questions](OPEN-QUESTIONS.md).

## Functional requirements

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-01 | Import one or multiple bank statements from one or multiple accounts. | A supported test set produces transactions associated with the correct source statement and account; unsupported or unreadable inputs are identified. |
| FR-02 | Extract and normalize individual transactions. | Supported inputs retain the information needed for reconciliation, including amount, currency, dates and available counterparty/reference information; unavailable fields are distinguishable from extracted values. |
| FR-03 | Analyze a selected local folder of mixed supporting documents. | Supported invoices, receipts, credit notes, and other agreed document types can coexist in the same folder without prior sorting; individual analysis failures are visible. |
| FR-04 | Extract document dates, amounts, currencies, merchants, and references where available. | Available supported fields are recorded; missing or ambiguous values remain identifiable rather than being invented. |
| FR-05 | Produce deterministic, explainable transaction-to-document match suggestions. | Reprocessing unchanged normalized data with the same rules produces the same suggestions, with the contributing evidence and conflicts available for review. |
| FR-06 | Distinguish reliable, uncertain, and unmatched results. | Each transaction has a clearly visible result under the agreed classification policy; competing candidates and unresolved evidence do not silently become confirmed matches. |
| FR-07 | Allow manual assignment, correction, and removal of matches. | A user can inspect and change a transaction's document association and see the resulting state. |
| FR-08 | Support multiple supporting documents for one transaction. | A user can assign and remove individual documents within a group for one transaction; the interface exposes relevant amount differences for review. Automatic group discovery is outside the proposed initial MVP. |
| FR-09 | Persist reconciliation progress locally. | After saving and reopening a workspace, its transactions, extracted document information, associations, and reconciliation states remain available. |
| FR-10 | Export renamed copies of matched supporting documents using associated bank transaction information. | Approved naming and grouping rules produce copies traceable to their associated transaction; originals remain unchanged. |
| FR-11 | Show a reconciliation summary. | The summary identifies matched, unmatched, and manually processed transactions under an agreed status model, including any overlaps explicitly defined by that model. |

FR-02 describes required information semantically; statement-specific field mappings and date semantics need agreement under Q-01 and Q-04. FR-08 does not decide whether a document may also support other transactions; Q-03 remains open.

## Non-functional requirements

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| NFR-01 | Preserve original statements and supporting documents. | Successful and failed import, analysis, matching, save, and export operations neither alter nor delete original files. |
| NFR-02 | Keep financial data local by default and support the core workflow offline. | Import through export works without network access after installation and any explicitly agreed local resource setup; no mandatory account, external service, or AI integration is required. |
| NFR-03 | Support Windows and Linux desktop use. | The agreed core acceptance scenario can be completed on both target platforms; supported versions are decided later. |
| NFR-04 | Prioritize financial correctness and visible uncertainty. | Monetary values and currencies survive normalization, persistence, and export without unintended rounding or currency substitution; extraction conflicts and operation failures are visible. |
| NFR-05 | Keep the architecture modular, extensible, and reasonably simple. | Later architecture review explains component responsibilities and significant trade-offs without speculative abstractions. |
| NFR-06 | Prefer mature libraries for common technical capabilities. | Later dependency choices assess maintenance, security, performance, documentation, tests, and license compatibility; architecture and product behavior are derived from ReceiptMatch's requirements. |

Performance targets and reference workload remain open under Q-09. No numeric processing limits, matching tolerances, or confidence thresholds are approved here.

## Proposed MVP

- A local reconciliation workspace supporting the complete core workflow.
- An explicitly agreed initial set of statement and supporting-document formats, with visible handling of unsupported inputs.
- Multiple statements and accounts, mixed supported document types, and document field extraction.
- Explainable deterministic suggestions, review of uncertain/unmatched transactions, and manual correction.
- Manual grouping of multiple documents for one transaction.
- Local save/resume, renamed-copy export, and a consistent reconciliation summary.
- Verification on Windows and Linux with representative agreed examples.

Scanned-document/OCR support is undecided, not silently excluded. The MVP cannot be finalized until Q-01 and Q-02 establish usable format coverage.

## Explicit exclusions from the proposed MVP

- Bank connections, payment execution, bookkeeping, tax calculations, and accountant-system integrations.
- Invoice-to-invoice matching or whole-statement comparison as the primary workflow.
- Mandatory cloud processing, online accounts, collaboration, or AI; optional local AI is a possible future topic.
- Automatic discovery of document groups, automatic split-payment allocation across transactions, and automatic foreign-exchange or fee allocation. Required manual behavior for these cases is decided under Q-03 and Q-04.
- Universal support for every bank, document format, language, or layout.
- Automated export of uncertain suggestions before the user resolves them; the exact confirmation policy remains Q-05.

## MVP acceptance

Use a representative, agreed fixture set containing multiple statements/accounts, supported mixed documents, an ambiguous candidate, an unmatched transaction, and several documents for one transaction. On both platforms, verify FR-01 through FR-11 and NFR-01 through NFR-04 through import, analysis, review, correction, save/reopen, summary, and export. Verify that originals remain unchanged, uncertainty is visible, and exported copies follow the agreed naming policy. NFR-05 and NFR-06 are assessed during the separately approved architecture/dependency review.

Product acceptance also requires resolving blocking questions and confirming or revising the proposed safeguards and assumptions in [Open Questions](OPEN-QUESTIONS.md). Acceptance evidence and workload targets must be agreed before claiming MVP completion.

## Assumptions and risks

- The user can provide authorized local statement/document examples; synthetic fixtures can cover additional cases. No production financial data should be required for planning.
- OCR quality, heterogeneous statement layouts, missing references, refunds, duplicate inputs, and currency differences may increase manual review.
- A high-quality match suggestion is not proof of accounting correctness; classification must remain explainable and reviewable.
- Angular/TypeScript are preferences, SQLite is a candidate, and Electron/Tauri require later evaluation. None is selected by this PRD.
- Proposed protections against duplicate imports, missing source files, overwritten export targets, and lost manual corrections require confirmation under A-02 through A-04.

Related documents: [User Stories](USER-STORIES.md), [Open Questions](OPEN-QUESTIONS.md), [MVP Roadmap](../planning/MVP-ROADMAP.md), [Backlog Draft](../planning/BACKLOG-DRAFT.md).
