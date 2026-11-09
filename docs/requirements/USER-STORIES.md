# ReceiptMatch User Stories

Status: proposed stories derived from [PRD](PRD.md). Format coverage and unresolved policies follow [Open Questions](OPEN-QUESTIONS.md); acceptance criteria do not set hidden defaults for them.

## Statement import

### US-01 Import statements — FR-01

**Goal:** As a user, I want to import statements from my accounts so that I can reconcile their individual transactions together.

**Expected behavior:** Select one or several supported local statements and retain each transaction's statement and account association.

**Acceptance:** Supported examples import with the correct associations; unreadable and unsupported files are identified without changing originals.

**Edge cases:** Multiple accounts, overlapping statement periods, repeated imports, and partly unreadable input. Duplicate policy is Q-06; preserving existing work is proposed in A-02.

### US-02 Inspect normalized transactions — FR-02

**Goal:** As a user, I want a consistent view of extracted transactions so that I can identify the correct transaction during reconciliation.

**Expected behavior:** Display normalized amounts, currencies, available dates, counterparties, and references with their source association.

**Acceptance:** Values agree with supported fixtures; unavailable fields and ambiguous date/amount interpretations are visible.

**Edge cases:** Debit/credit signs, refunds, booking versus value dates, locale-specific number formats, missing references, and repeated equal-value transactions. Q-01 and Q-04 govern the supported semantics.

## Supporting documents

### US-03 Analyze a mixed document folder — FR-03

**Goal:** As a user, I want to select my existing document folder so that I do not need to sort invoices, receipts, or credit notes first.

**Expected behavior:** Discover and analyze supported documents from the selected folder and identify files that could not be processed.

**Acceptance:** Agreed mixed document types are processed together; failure of one file is visible and does not conceal successful results from other files.

**Edge cases:** Empty folder, inaccessible files, unsupported files, duplicate copies, and nested folders. Recursion is Q-08; OCR coverage is Q-02.

### US-04 Review extracted document information — FR-04

**Goal:** As a user, I want extracted document details available for review so that I can assess a proposed match.

**Expected behavior:** Show available date, amount, currency, merchant, and reference information, including missing or conflicting evidence.

**Acceptance:** Supported fixtures produce expected fields; missing or ambiguous information is identifiable and is not replaced with guessed facts.

**Edge cases:** Several amounts or dates, invoice versus payment references, credit notes, foreign currencies, scans, and password-protected or damaged files. Field-editing requirements remain Q-10.

## Matching and review

### US-05 Understand match suggestions — FR-05

**Goal:** As a user, I want explainable suggested documents for each transaction so that I can judge whether they belong together.

**Expected behavior:** Apply deterministic matching rules and expose supporting evidence and conflicts for candidates.

**Acceptance:** Identical normalized inputs and rules produce identical suggestions; the user can inspect why candidates were suggested.

**Edge cases:** Same amount/date across merchants, missing references, date differences, fees, and currency differences. Tolerances and supported comparisons remain Q-04 and Q-05.

### US-06 Distinguish reliable, uncertain, and unmatched results — FR-06

**Goal:** As a user, I want unresolved transactions clearly separated so that I can focus my review.

**Expected behavior:** Show result classes under the agreed policy and distinguish suggested associations from manual decisions.

**Acceptance:** Reliable, uncertain, and unmatched cases in the agreed fixtures receive the expected class; competing candidates remain visible and no unresolved ambiguity silently becomes confirmed work.

**Edge cases:** Several equivalent candidates, no usable document fields, and a document already associated elsewhere. Q-03 and Q-05 govern conflicts and confirmation.

### US-07 Correct an association — FR-07

**Goal:** As a user, I want to assign, replace, or remove a document so that I can correct an automatic suggestion.

**Expected behavior:** Inspect the transaction and document, perform the change, and see the updated association and status.

**Acceptance:** Each operation updates the displayed state and remains after save/reopen; a removed match no longer appears as active.

**Edge cases:** Replacing an existing association, conflicting use of a document, and rerunning analysis after correction. Conflict behavior is Q-03; retaining manual work during reprocessing is proposed in A-02.

### US-08 Group documents for a transaction — FR-08

**Goal:** As a user, I want to associate several documents with one transaction so that one payment can have several pieces of evidence.

**Expected behavior:** Manually build and inspect a document group, including relevant amounts and differences, and remove group members individually.

**Acceptance:** A transaction can retain multiple distinct document associations after save/reopen; group differences are visible without being silently resolved; export follows the agreed group naming policy.

**Edge cases:** Group total differs from payment, mixed currencies, credit notes, duplicate documents, or shared documents. Q-03, Q-04, and Q-07 decide their supported treatment. Automatic group discovery is excluded from the proposed MVP.

## Persistence and summary

### US-09 Resume reconciliation — FR-09

**Goal:** As a user, I want to save and reopen my progress so that I can finish reconciliation over several sessions.

**Expected behavior:** Persist the workspace locally and restore transactions, extracted document details, associations, and states.

**Acceptance:** Explicitly saved work survives application restart with the same associations and states; save/open failures are visible.

**Edge cases:** Moved, renamed, or deleted source files; changed content; interrupted saves; and repeat analysis. Source handling and save/recovery policy remain Q-08 and Q-11; A-02 and A-03 propose safeguards.

### US-10 Review reconciliation progress — FR-11

**Goal:** As a user, I want a summary of matched, unmatched, and manually processed transactions so that I can identify remaining work.

**Expected behavior:** Show summary counts consistent with transaction states and refresh them after reconciliation changes.

**Acceptance:** Fixture results and manual corrections produce the expected counts under the agreed status model; relationships or overlaps between manual processing and matching are explicit.

**Edge cases:** A manually processed transaction without a document, removed associations, several documents for one transaction, and empty workspaces. The meaning of manual processing is Q-05.

## Export

### US-11 Export renamed document copies — FR-10

**Goal:** As a user, I want matched evidence exported under transaction-based names so that I can prepare documents for my accountant.

**Expected behavior:** Export copies under the agreed transaction-based naming policy, including several documents per transaction, and report the outcome.

**Acceptance:** The agreed eligible matches produce correctly named copies linked to transaction information; original statements/documents are unchanged; skipped or failed exports are visible. Export eligibility and naming are Q-05 and Q-07.

**Edge cases:** Duplicate names, existing destination files, missing sources, invalid filename characters, destination inside the source folder, repeated exports, and partial failure. Protecting existing target files is proposed in A-04; no overwrite policy is assumed approved.

## Cross-cutting acceptance

All stories inherit original-file protection, local/offline operation, Windows/Linux support, and financial correctness from NFR-01 through NFR-04. Approval of these stories does not finalize unresolved product policies or authorize technical implementation.
