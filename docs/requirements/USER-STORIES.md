# ReceiptMatch User Stories

Status: stories follow approved DEC-01 through DEC-11 in the [PRD](PRD.md). [REC-2](https://wigtertainment.atlassian.net/browse/REC-2) implements the workspace foundation of US-09; later work remains separately gated. Remaining layout/policy details follow [Open Questions](OPEN-QUESTIONS.md).

## Statement import

### US-01 Import statements — FR-01

**Goal:** As a user, I want to import statements from my accounts so that I can reconcile their individual transactions together.

**Expected behavior:** Select one or several local PDF statements and retain each individual transaction's statement and account association (DEC-01).

**Acceptance:** Representative supported text-based and scanned PDF layouts import individual transactions with correct associations; unreadable/unsupported inputs are identified without changing originals. CSV/CAMT statement import is outside the MVP; universal PDF support is not assumed.

**Edge cases:** Multiple accounts, overlapping statement periods, repeated imports, and partly unreadable input. Identical files are skipped; possible duplicate transactions remain visible without amount-only auto-merge (DEC-10). Remaining details are Q-06.

### US-02 Inspect normalized transactions — FR-02

**Goal:** As a user, I want a consistent view of extracted transactions so that I can identify the correct transaction during reconciliation.

**Expected behavior:** Display normalized amounts, currencies, available dates, counterparties, and references with their source association.

**Acceptance:** Values agree with supported PDF fixtures; embedded text is preferred and local OCR used when necessary; extraction failures, uncertainty, and unavailable/ambiguous fields are visible without invented financial values (DEC-02).

**Edge cases:** Debit/credit signs, refunds, booking versus value dates, locale-specific number formats, missing references, and repeated equal-value transactions. Q-01 and Q-04 govern the supported semantics.

## Supporting documents

### US-03 Analyze a mixed document folder — FR-03

**Goal:** As a user, I want to select my existing document folder so that I do not need to sort invoices, receipts, or credit notes first.

**Expected behavior:** Discover and analyze supported documents from the selected folder and identify files that could not be processed.

**Acceptance:** Agreed mixed document types are processed together; failure of one file is visible and does not conceal successful results from other files.

**Edge cases:** Empty folder, inaccessible files, unsupported files, duplicate copies, and nested folders. Recursion is Q-08; concrete formats and representative English OCR fixtures remain Q-02. Local OCR and the initial English language selection are settled.

### US-04 Review extracted document information — FR-04

**Goal:** As a user, I want extracted document details available for review so that I can assess a proposed match.

**Expected behavior:** Prefer embedded text and use local OCR when necessary; show available date, amount, currency, merchant, and reference information, including missing or conflicting evidence (DEC-02).

**Acceptance:** Representative text/scanned fixtures produce expected fields using local processing; extraction failures and uncertainty are visible, and missing/ambiguous information is not replaced with guessed facts. No mandatory cloud OCR or external AI API is needed.

**Edge cases:** Several amounts or dates, invoice versus payment references, credit notes, foreign currencies, scans, and password-protected or damaged files. Field-editing requirements remain Q-10.

## Matching and review

### US-05 Understand match suggestions — FR-05

**Goal:** As a user, I want explainable suggested documents for each transaction so that I can judge whether they belong together.

**Expected behavior:** Apply deterministic matching rules and expose supporting evidence and conflicts for candidates.

**Acceptance:** Identical normalized inputs and rules produce identical suggestions; the user can inspect why candidates were suggested.

**Edge cases:** Same amount/date across merchants, missing references, date differences, fees, and currency differences. Tolerances and supported comparisons remain Q-04 and Q-05.

### US-06 Distinguish reliable, uncertain, and unmatched results — FR-06

**Goal:** As a user, I want unresolved transactions clearly separated so that I can focus my review.

**Expected behavior:** Show result classes under the agreed policy, keep confidence separate from approval, and allow review of every suggestion (DEC-03).

**Acceptance:** Reliable, uncertain, and unmatched cases receive expected classes; competing candidates remain visible. Reliable confidence does not approve an association or make it exportable; all automatic assignments remain reviewable suggestions.

**Edge cases:** Several equivalent candidates, no usable document fields, and a document already associated elsewhere. Q-03 and Q-05 govern remaining conflicts, classification, and approval details; only approved associations qualify for document-copy export.

### US-07 Correct an association — FR-07

**Goal:** As a user, I want to assign, replace, or remove a document so that I can correct an automatic suggestion.

**Expected behavior:** Inspect the transaction and document, perform the change, and see the updated association and status.

**Acceptance:** Each operation updates the displayed state and remains after save/reopen; a removed match no longer appears as active.

**Edge cases:** Replacing an association, conflicting document use, and reanalysis. Relevant changes revoke affected approvals; unchanged reanalysis retains manual work (DEC-09). Remaining conflict behavior is Q-03/Q-06.

### US-12 Review and batch-approve associations — FR-12

**Goal:** As a user, I want to review suggested assignments and approve them in batches so that I retain control without confirming every reliable match separately.

**Expected behavior:** Make all suggestions reviewable, allow manual additions/corrections/removals, and support batch approval after review (DEC-03).

**Acceptance:** Reviewed associations can be approved together; confidence and approval remain distinct and persist after save/reopen. Unapproved associations never produce matched-document copies, even when confidence is reliable.

**Edge cases:** Mixed confidence, competing suggestions, manual associations, edits, and reanalysis. DEC-09 defines affected-approval revocation and unchanged-work preservation; detailed batch selection/conflict handling remains Q-05/Q-06.

### US-08 Group documents for a transaction — FR-08

**Goal:** As a user, I want to associate several documents with one transaction so that one payment can have several pieces of evidence.

**Expected behavior:** Manually build and inspect a document group, including relevant amounts and differences, and remove group members individually.

**Acceptance:** A transaction can retain multiple distinct document associations after save/reopen; group differences are visible without being silently resolved; approved members export under the agreed group naming policy (DEC-03, DEC-05).

**Edge cases:** Group total differs from payment, mixed currencies, credit notes, duplicate documents, or shared documents. Q-03, Q-04, and Q-07 decide remaining group treatment. Future one-document-to-many-transactions support must remain feasible; full partial-payment UI, automatic split allocation, and automatic group discovery are outside the MVP.

## Persistence and summary

### US-09 Resume reconciliation — FR-09

**Goal:** As a user, I want to save and reopen my progress so that I can finish reconciliation over several sessions.

**Expected behavior:** Create/open local workspaces and explicitly save changes through the English interface. Reference original files in place and restore persisted data with confidence separate from approval/reconciliation states.

**Acceptance:** Saved work survives restart with the same data/associations/states. Unsaved changes trigger a warning before discard. Cancelled/failed operations retain current work; foreign, corrupt, or unsupported workspace files are rejected without modification. Save/open errors are visible.

**Edge cases:** Cancelled dialogs, save failure/collision, switching workspaces while dirty, invalid files, moved/changed sources, interrupted saves, and reanalysis. Explicit saving/source references are settled; additional recovery/relinking remains Q-08/Q-11.

### US-10 Review reconciliation progress — FR-11

**Goal:** As a user, I want a summary of matched, unmatched, and manually processed transactions so that I can identify remaining work.

**Expected behavior:** Show summary counts consistent with transaction states and refresh them after reconciliation changes.

**Acceptance:** Fixture results, approvals, and manual corrections produce expected counts under the agreed status model; unmatched/unresolved transactions remain visible, confidence and approval are distinct, and relationships between manual processing and matching are explicit.

**Edge cases:** A manually processed transaction without a document, removed associations, several documents for one transaction, and empty workspaces. The meaning of manual processing is Q-05.

## Export

### US-11 Export renamed document copies — FR-10

**Goal:** As a user, I want approved evidence exported under transaction-based names so that I can prepare documents for my accountant.

**Expected behavior:** Export only approved document associations under the agreed transaction-based naming policy, including several documents per transaction, and report the outcome (DEC-03, DEC-04).

**Acceptance:** Approved associations produce correctly named copies linked to transaction information; unapproved associations produce no document copies regardless of confidence. Original statements/documents remain unchanged; skipped/failed exports are visible. Exact names, collision handling, and directory structure remain Q-07.

**Edge cases:** Duplicate names, existing targets, missing sources, invalid filename characters, source-directory overlap, repeated exports, and partial failure. Existing files must not be overwritten (DEC-11); detailed presentation remains Q-07.

### US-13 Export a CSV reconciliation report — FR-13

**Goal:** As a user, I want a CSV report so that I can inspect and share the reconciliation outcome, including outstanding work.

**Expected behavior:** Export transaction/document references, reconciliation statuses, and relevant matching information (DEC-04).

**Acceptance:** The report represents approved associations and unmatched/unresolved transactions under the agreed CSV contract; confidence and approval are not conflated. References agree with saved reconciliation information; exact fields and row structure remain Q-07. The approval restriction on document-copy export does not hide open transactions from the report.

**Edge cases:** Transactions without documents, several documents per transaction, unapproved suggestions, failed copies, and repeated reports. UTF-8/comma `reconciliation.csv` and no-overwrite are settled; exact fields/rows and partial-failure presentation remain Q-07.

## Cross-cutting acceptance

All stories inherit original-file protection, local/offline operation, Windows/Linux support, and financial correctness from NFR-01 through NFR-04. Approval of these stories does not finalize unresolved product policies or authorize technical implementation.
