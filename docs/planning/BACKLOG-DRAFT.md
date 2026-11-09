# ReceiptMatch Initial Backlog

Status: backlog follows approved DEC-01 through DEC-11. Jira project REC is the leading implementation backlog: [REC-1](https://wigtertainment.atlassian.net/browse/REC-1) contains the initial workflow; [REC-2](https://wigtertainment.atlassian.net/browse/REC-2) implements authorized subphase 3.1 / BL-03. Other items remain proposals with separate approval gates. IDs stay stable for requirements traceability.

## Epics

| ID | Epic | Completion condition | Dependencies |
| --- | --- | --- | --- |
| EP-01 | Agreed product and technical foundation | Initial product decisions, fixtures, and a separately approved architecture evaluation support the core workflow. | Phase 1 review |
| EP-02 | Early complete reconciliation workflow | A user can complete the small PDF/local-OCR workflow through review/batch approval, approved document copies, and CSV report on Windows/Linux. | EP-01 |
| EP-03 | Complete MVP input and association coverage | All agreed PDF layouts/document formats, multiple accounts/statements, and manual document groups work with the full workflow. | EP-02 |
| EP-04 | Verified reliable MVP | Full agreed acceptance, platform, failure, and workload checks pass. | EP-03 |

## EP-01 — Product and foundation

### BL-01 Agree scope and acceptance examples — R-00

**Trace:** All requirements and stories; Q-01 through Q-12; A-01 through A-06.

**Subtasks:** ST-01.1 retain approved DEC-01 through DEC-05, English OCR and Ubuntu selection, and agree representative PDF/text/scanned/OCR fixtures and remaining format coverage; ST-01.2 agree remaining matching/status/approval/group/export/CSV policies; ST-01.3 agree acceptance outcomes, supported Windows/Ubuntu releases, workload, and safeguards.

**Acceptance:** Approved decisions are distinguished from partially resolved/open questions; affected implementation cannot start on unanswered blocking policies. Fixture outcomes cover PDF/local-OCR extraction, separate confidence/approval, batch review, both exports, and manual groups. No universal PDF support, CSV/CAMT import, or full partial-payment UI is implied.

**Dependencies:** User review of Phase 1. Later decisions may be completed before their affected work rather than delaying unrelated planning.

### BL-02 Evaluate architecture and common libraries — R-01

**Trace:** NFR-01 through NFR-06; all functional areas.

**Subtasks:** ST-02.1 evaluate Electron/Tauri, Angular/TypeScript integration, safe filesystem access, and Windows/Linux packaging; ST-02.2 evaluate SQLite persistence, PDF extraction, local OCR and document libraries, deterministic matching, future many-to-many associations, separate confidence/approval, CSV and safe document export; ST-02.3 review security, tests, offline operation, modular boundaries, dependency criteria, and trade-offs.

**Acceptance:** The proposed Software Architect/Desktop App Engineer handoff covers the full [Phase 2 scope](MVP-ROADMAP.md), with alternatives, risks, unresolved product assumptions, extraction/packaging validation needs, and a testing plan. It supports DEC-01 through DEC-05 and dependency/license constraints without treating preferences/candidates as selected technologies or delivering application code.

**Dependencies:** BL-01 decisions relevant to architecture and separate authorization for architecture work.

## EP-02 — Early complete workflow

### BL-03 Create and reopen a local workspace — R-02

**Trace:** FR-09; US-09; NFR-01 through NFR-04.

**Jira:** REC-2, under REC-1. Approved implementation scope: subphase 3.1 only.

**Delivery:** Implemented and verified, pending user acceptance. Evidence and limits are in [Architecture Evaluation](../architecture/ARCHITECTURE-EVALUATION.md); no merge request is commissioned.

**Subtasks:** ST-03.1 establish local workspace lifecycle; ST-03.2 persist and restore reconciliation information; ST-03.3 expose save/open failures and verify original protection.

**Acceptance:** English create/open/explicit-save workflow warns before discarding unsaved work. Cancelled/failed operations preserve current state; invalid/foreign files are not modified. Saved data survives restart with exact values and independent confidence/approval; future many-to-many readiness is retained. The packaged foundation runs offline on Windows/Ubuntu without importing, matching, or exporting financial documents.

**Dependencies:** BL-02; approved save/source policy relevant to Q-08 and Q-11.

### BL-04 Import initial statements and analyze a mixed folder — R-02

**Trace:** FR-01 through FR-04; US-01 through US-04.

**Subtasks:** ST-04.1 import representative text/scanned PDF statement layouts and normalize individual transactions; ST-04.2 analyze supported mixed documents, prefer embedded text, and use required local OCR when necessary; ST-04.3 retain source/account associations, persist results, and expose extraction failures/uncertainty/missing fields.

**Acceptance:** Initial PDF/document fixtures and account/source associations match validated expectations; supported mixed text/scanned documents need no sorting. Local OCR works without mandatory cloud/AI APIs, embedded text is preferred, failures/uncertainty are visible, and missing financial values are not invented. Originals remain unchanged.

**Dependencies:** BL-03; remaining Q-01/Q-02 and relevant Q-04/Q-08 decisions. Local OCR is required under DEC-02, not a conditional addition; concrete layouts/languages/formats remain bounded by approved fixtures.

### BL-05 Suggest explainable matches and expose result classes — R-02

**Trace:** FR-05 and FR-06; US-05 and US-06.

**Subtasks:** ST-05.1 apply agreed deterministic matching rules; ST-05.2 show evidence, conflicts, and confidence/result classes separately from approval; ST-05.3 persist relevant results and verify repeatability and reviewability of all suggestions.

**Acceptance:** Fixtures have expected reliable, uncertain, and unmatched cases; identical inputs/rules give identical suggestions. Every suggestion remains reviewable, reliable confidence does not imply approval, and unresolved evidence stays visible (DEC-03).

**Dependencies:** BL-04; Q-03 through Q-05 decisions affecting suggestions and classification.

### BL-06 Review, correct, batch-approve, and track progress — R-02

**Trace:** FR-07, FR-09, FR-11, and FR-12; US-07, US-09, US-10, and US-12.

**Subtasks:** ST-06.1 review all suggestions and add/replace/remove associations; ST-06.2 batch-approve after review and represent manual processing under the agreed status policy; ST-06.3 update the summary and verify saved associations, confidence, and separate approval states after restart.

**Acceptance:** Reviewed associations can be batch-approved without individual confirmation of every reliable match; confidence and approval remain separate. Corrections/approvals survive save/reopen and summary counts remain consistent, with unmatched/unresolved work visible. Approval effects of edits/reanalysis follow the policy still to be resolved under Q-05/Q-06.

**Dependencies:** BL-05; Q-03, Q-05, and relevant Q-06 decisions.

### BL-07 Export the first complete reconciliation — R-02

**Trace:** FR-10, FR-12, and FR-13; US-11 through US-13; NFR-01 through NFR-04.

**Subtasks:** ST-07.1 select approved associations and derive names under the agreed transaction naming policy; ST-07.2 copy approved documents, export the CSV reconciliation report, and expose success/skips/failures; ST-07.3 demonstrate import, local extraction/OCR, suggestions, correction, batch approval, save/reopen, summary, and both exports together.

**Acceptance:** Only approved associations produce transaction-named copies; confidence alone never makes them eligible. The CSV includes transaction/document references, statuses, and relevant matching information, also representing unmatched/unresolved work under agreed fields/row structure. Originals remain unchanged; the agreed document/report collision policy protects source paths and handles existing targets. The complete scenario runs offline on Windows/Linux.

**Dependencies:** BL-06; Q-05 and Q-07 resolved; accepted export safeguards. This is the first end-to-end milestone, before broader coverage.

## EP-03 — Complete MVP coverage

### BL-08 Complete agreed input and repeat-processing coverage — R-03

**Trace:** FR-01 through FR-04 and FR-09; US-01 through US-04 and US-09.

**Subtasks:** ST-08.1 cover remaining agreed PDF layouts, supporting-document formats, and required local English OCR cases; ST-08.2 verify multiple statements/accounts and approved duplicate handling; ST-08.3 handle source changes/reanalysis under approved preservation/approval rules.

**Acceptance:** The representative supported PDF/text/scanned-document matrix retains correct account/source associations; unsupported/failed/uncertain extraction remains visible. Duplicate/reanalysis/source-change behavior follows agreed policies, including approval effects, and preserves manual work where A-02/A-03 are accepted. CSV/CAMT statement import remains outside the MVP.

**Dependencies:** BL-07; Q-01, Q-02, Q-04, Q-06, and Q-08 decisions for this scope. Matching and export are rechecked when new input cases affect them.

### BL-09 Support manual document groups throughout the workflow — R-03

**Trace:** FR-07 through FR-13; US-07 through US-13.

**Subtasks:** ST-09.1 manually assign/remove group members and expose relevant amount differences; ST-09.2 preserve groups and separate confidence/approval with correct summary counts across restart; ST-09.3 export approved group members and represent groups in CSV under agreed naming/conflict/report rules.

**Acceptance:** Several documents support one transaction with reviewable differences and persistent individual associations/approvals; both exports retain agreed behavior. Future one-document-to-many-transactions support remains feasible, but full partial-payment UI and automatic split allocation are excluded (DEC-05); automatic grouping/conversion is not presumed.

**Dependencies:** BL-07; Q-03 through Q-05 and Q-07 decisions. BL-08 is completed first under the proposed sequential roadmap.

## EP-04 — Reliable MVP acceptance

### BL-10 Verify full workflow, failures, and platform delivery — R-04

**Trace:** FR-01 through FR-13; US-01 through US-13; NFR-01 through NFR-06.

**Subtasks:** ST-10.1 verify representative PDF/local-OCR fixtures, ambiguity, missing information, refunds, agreed currency/groups, repeat imports, manual correction, separate confidence/approval, and batch approval; ST-10.2 exercise agreed save/source/document/CSV failure/collision behavior and approved-only document copies; ST-10.3 validate offline/local operation, original integrity, agreed workloads, and platform/OCR packaging; ST-10.4 review acceptance gaps and dependency/architecture commitments, including future format/many-to-many readiness.

**Acceptance:** Agreed outcomes pass on supported Windows/Linux targets; originals remain unchanged on success/failure. Summary and CSV retain unmatched/unresolved work; document copies contain approved associations only; persisted confidence/approval match reviewed decisions. Required local OCR, accepted safeguards, and workload targets pass. Unresolved failures or scope gaps prevent an unqualified MVP completion claim.

**Dependencies:** BL-08 and BL-09; Q-09 and Q-12 acceptance targets, plus all remaining decisions required by the accepted scope.

## Coverage and sequencing

FR-01–FR-04: BL-04/BL-08. FR-05–FR-06: BL-05. FR-07: BL-06/BL-09. FR-08: BL-09. FR-09: BL-03 and persistence checks in later stories. FR-10/FR-13: BL-07/BL-09. FR-11/FR-12: BL-06/BL-09. NFR-01–NFR-04 apply throughout; NFR-05–NFR-06 are addressed in BL-02 and reviewed in BL-10. Approved DEC-01–DEC-05 constrain all affected work; unresolved details retain their Q-01–Q-12 references.

Proposed order: BL-01 → BL-02 → BL-03 → BL-04 → BL-05 → BL-06 → BL-07 → BL-08 → BL-09 → BL-10. Dependencies describe readiness; they do not authorize concurrent work or bypass user approval gates. Future backlog expansion or new documentation requires the applicable approval.
