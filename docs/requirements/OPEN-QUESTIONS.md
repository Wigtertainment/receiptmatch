# ReceiptMatch Open Questions

Status: DEC-01 through DEC-11 are approved. Subphase 3.1 is authorized; later subphases require separate approval. “Blocking” means blocking the affected implementation or acceptance; settled decisions below are not reopened.

## Approved decisions

| ID | Status | Approved scope |
| --- | --- | --- |
| DEC-01 | Approved | Initial statement import is PDF only, covering representative text-based and scanned layouts and extracting individual transactions with source statement/account associations. CSV, CAMT, and other statement imports are outside the MVP; future format extensibility remains required. Universal PDF support is not assumed. |
| DEC-02 | Approved | Local OCR is required, preferring embedded text and using OCR when necessary. Extraction failures and uncertainty must be visible without invented financial data; no mandatory cloud OCR or external AI API. Established libraries and platform packaging are evaluated later. |
| DEC-03 | Approved | Automatic matches are reviewable suggestions. Confidence and approval are separate; users may add/correct/remove associations and batch-approve after review. Only approved associations qualify for matched-document export; unmatched/unresolved transactions remain visible. |
| DEC-04 | Approved | Export renamed copies of approved supporting documents using associated transaction information, plus a CSV report with transaction/document references, reconciliation statuses, and relevant matching information. Originals remain unchanged; exact export details remain open. |
| DEC-05 | Approved | Manually associating multiple documents with one transaction is in the MVP. Future many-to-many associations must remain feasible; full partial-payment workflows/dedicated UI and automatic split allocation are deferred. No technical data model is selected. |
| DEC-06 | Approved | Initial providers are Revolut and Airwallex, initially in EUR. Supporting documents are PDF, PNG, and JPEG; concrete statement layouts and expected examples still need agreement. English OCR and Ubuntu remain selected. |
| DEC-07 | Approved | Initial interface is English. Workspaces are explicitly saved, with a warning before discarding unsaved changes. Original documents are referenced and remain unchanged. |
| DEC-08 | Approved | Matching requires exact amount, compatible payment direction, and the same currency, with no conversion. Date proximity within ±7 calendar days is evidence. Reliable suggestions require a unique matching reference and consistent amount/currency without conflicting evidence. |
| DEC-09 | Approved | Relevant data changes revoke affected approvals; unchanged reanalysis preserves manual work. Transactions deliberately completed without a document remain visible. Confidence never implies approval. |
| DEC-10 | Approved | Skip content-identical file imports. Show potentially duplicate transactions; never merge them automatically merely because amounts match. |
| DEC-11 | Approved | Export to a separate destination using `documents/` and `reconciliation.csv`, without overwriting existing files. Names use booking date, counterparty, currency, amount, and transaction ID. CSV uses UTF-8 and comma delimiters, includes open transactions, references, confidence, approval, and export outcome. |

These decisions resolve portions of Q-01, Q-02, Q-03, Q-05, and Q-07. The remaining questions below do not reopen approved scope.

The user subsequently approved the architecture recommendation and technical validation experiments and selected English OCR and Ubuntu Linux. Ubuntu 24.04 x64 is the current container test target; the supported release/distribution matrix still needs agreement under Q-09.

The user approved the four-part R-02 subdivision and the rule proposals recorded as DEC-06 through DEC-11, and authorized 3.1. Jira project REC is the leading backlog: [REC-1](https://wigtertainment.atlassian.net/browse/REC-1) contains the workflow, with [REC-2](https://wigtertainment.atlassian.net/browse/REC-2) covering the desktop workspace foundation. Concrete PDF layouts and expected examples remain unresolved; provider selection does not imply universal layout support.

## Blocking decisions

| ID | Status | Remaining decision needed | Why it blocks affected work |
| --- | --- | --- | --- |
| Q-01 | Partially resolved by DEC-01/DEC-06 | Which Revolut and Airwallex EUR PDF layouts, text/scanned samples, and date/number conventions define initial support? Supply representative authorized or synthetic fixtures with expected individual transactions. | Defines bounded extraction coverage; no universal layout support is promised. |
| Q-02 | Partially resolved by DEC-02/DEC-06 | Which representative PDF/PNG/JPEG layouts and text/scanned fixtures are required? What extraction outcomes and visible uncertainty are acceptable? | Formats and English OCR are settled; concrete coverage and accuracy still need examples. |
| Q-03 | Partially resolved by DEC-05 | How should manual groups handle conflicting associations, duplicate members, credit notes, amount differences, and mixed currencies within MVP scope? | Defines group review/acceptance. Future many-to-many readiness is approved; full partial-payment workflows/UI and automatic split allocation are deferred. |
| Q-04 | Partially resolved by DEC-08 | Which source date/amount fields, refund signs, fee handling, and missing/conflicting-field rules apply to the agreed layouts? How should mixed-currency groups be reviewed? | Exact same-currency/direction-compatible matching and ±7-day date evidence are settled; field semantics and group cases remain open. |
| Q-05 | Partially resolved by DEC-03/DEC-08/DEC-09 | What exact reference normalization, reviewed-batch selection, manual-processing states/counts, and affected-revision boundaries are needed? | Reliable criteria and approval invalidation/preservation principles are settled; detailed status and transition behavior remains to be specified. |
| Q-06 | Partially resolved by DEC-09/DEC-10 | How should potentially overlapping transactions be identified and presented? What is the user resolution flow for conflicting reanalysis? | Identical-file skipping, no amount-only auto-merge, and preservation of unchanged manual work are settled. |
| Q-07 | Partially resolved by DEC-04/DEC-11 | What are the exact filename syntax, CSV columns/row structure, BOM/consumer expectations, group naming, and presentation of collisions/partial failures? | Output directories, filename components, UTF-8/comma CSV, open-work coverage, and no-overwrite policy are settled. |

## Non-blocking decisions for initial planning

These can remain open while requirements are reviewed, but must be resolved before implementing or accepting the affected feature.

| ID | Status | Decision needed | Affected work |
| --- | --- | --- | --- |
| Q-08 | Partially resolved by DEC-07 | Should folder analysis recurse? What should happen when referenced source files move/change, and is user-assisted relinking required? | References in place and original protection are settled; discovery/relinking remains open. |
| Q-09 | Partially resolved by Ubuntu selection | What representative workload, processing responsiveness, supported Windows/Ubuntu releases and architectures, and distribution expectations should define MVP acceptance? | Ubuntu is the selected Linux target; a container run on 24.04 x64 does not settle the release matrix. No arbitrary volume or timing promises are made. |
| Q-10 | Partially resolved by DEC-07 | May users edit extracted transaction/document fields, or only associations initially? Which display locale should be used? | English UI is settled; field-editing and locale details remain open. |
| Q-11 | Partially resolved by DEC-07 | Are additional crash recovery, backup/export of workspaces, or encryption required? What diagnostic data may be retained locally? | Explicit save and unsaved-change warnings are settled; additional recovery/privacy scope remains open. |
| Q-12 | Open | What evidence should demonstrate reduced manual effort and acceptable match quality on the agreed sample set? | Measurable product success; coverage and correctness must be assessed without claiming unvalidated precision targets. |

## Reasonable initial assumptions and proposed safeguards

The approved portions below are identified explicitly; remaining safeguards stay proposals.

| ID | Proposal | Consequence if revised |
| --- | --- | --- |
| A-01 | A local workspace organizes each reconciliation activity; multi-user collaboration and cloud synchronization are excluded from the proposed MVP. | Shared or synchronized work would expand persistence and conflict requirements. |
| A-02 | Preserving unchanged manual work and revoking affected approvals on relevant changes are approved under DEC-09. Conflicting evidence must remain reviewable. | Detailed conflict resolution remains Q-05/Q-06. |
| A-03 | Unavailable or changed source files should be reported, with saved reconciliation decisions retained; portable source copies and relinking are not assumed. | Copying or relinking requirements would add workspace-management scope under Q-08. |
| A-04 | No-overwrite export is approved under DEC-11; failures remain visible per affected output. | Collision presentation and alternate-name behavior remain Q-07; replacing existing files is not approved. |
| A-05 | The first complete workflow can use a deliberately small agreed fixture set; all required supported formats and multiple-account cases must be covered before MVP acceptance. | Broader initial coverage changes sequencing, not the final agreed acceptance scope. |
| A-06 | Manual multiple-document grouping and deferral of full partial-payment UI/automatic split allocation are approved under DEC-05. Deferring automatic group discovery and automatic currency/fee allocation remains proposed. | Expanding automatic handling would add rules, explanations, and acceptance cases; future many-to-many readiness remains required. |

## Decisions deliberately reserved for later

Software Architect and Desktop App Engineer completed the authorized Phase 2 evaluation. The user approved the [architecture recommendation and technical validations](../architecture/ARCHITECTURE-EVALUATION.md); evidence is recorded there. Electron/Tauri, Angular/TypeScript integration, SQLite persistence, safe filesystem access, PDF/OCR extraction, deterministic matching, future many-to-many readiness, separate confidence/approval, CSV/document export, Windows/Linux packaging, security/testing, and offline operation form the [evaluation scope](../planning/MVP-ROADMAP.md). The approved validation baseline does not settle the final schema, open product policies, or production readiness. Additional documentation files require applicable approval.
