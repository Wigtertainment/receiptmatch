# ReceiptMatch Initial Backlog

Status: proposal only. No Jira tickets have been created, and these items do not authorize implementation. IDs are planning references. Each story below has proposed subtasks; later technical decomposition depends on approved architecture and scope.

## Epics

| ID | Epic | Completion condition | Dependencies |
| --- | --- | --- | --- |
| EP-01 | Agreed product and technical foundation | Initial product decisions, fixtures, and a separately approved architecture evaluation support the core workflow. | Phase 1 review |
| EP-02 | Early complete reconciliation workflow | A user can complete the agreed small import-to-export scenario on Windows and Linux. | EP-01 |
| EP-03 | Complete MVP input and association coverage | All agreed formats, multiple accounts/statements, and manual document groups work with the full workflow. | EP-02 |
| EP-04 | Verified reliable MVP | Full agreed acceptance, platform, failure, and workload checks pass. | EP-03 |

## EP-01 — Product and foundation

### BL-01 Agree scope and acceptance examples — R-00

**Trace:** All requirements and stories; Q-01 through Q-12; A-01 through A-06.

**Subtasks:** ST-01.1 record decisions on formats/OCR and representative inputs; ST-01.2 agree matching/status/association/export policies; ST-01.3 agree acceptance outcomes, target platforms, workload, and safeguards.

**Acceptance:** Initial scope and unresolved decisions are distinguishable; affected work cannot start on unanswered blocking policies; fixture outcomes cover the required workflow and edge cases. No Jira creation is implied.

**Dependencies:** User review of Phase 1. Later decisions may be completed before their affected work rather than delaying unrelated planning.

### BL-02 Evaluate architecture and common libraries — R-01

**Trace:** NFR-01 through NFR-06; all functional areas.

**Subtasks:** ST-02.1 evaluate Electron/Tauri and the Angular/TypeScript preference; ST-02.2 evaluate local persistence including SQLite and input/OCR library needs; ST-02.3 review modular boundaries, dependency criteria, and significant trade-offs.

**Acceptance:** A reviewable technical proposal supports the accepted offline Windows/Linux workflow and dependency/license constraints; preferences and candidates are not treated as prior selections.

**Dependencies:** BL-01 decisions relevant to architecture and separate authorization for architecture work.

## EP-02 — Early complete workflow

### BL-03 Create and reopen a local workspace — R-02

**Trace:** FR-09; US-09; NFR-01 through NFR-04.

**Subtasks:** ST-03.1 establish local workspace lifecycle; ST-03.2 persist and restore reconciliation information; ST-03.3 expose save/open failures and verify original protection.

**Acceptance:** A saved workspace reopens with the same persisted information; subsequent stories add their own data and verify restart behavior. The lifecycle runs on both target platforms without required external services.

**Dependencies:** BL-02; approved save/source policy relevant to Q-08 and Q-11.

### BL-04 Import initial statements and analyze a mixed folder — R-02

**Trace:** FR-01 through FR-04; US-01 through US-04.

**Subtasks:** ST-04.1 import the agreed initial statement examples and normalize transactions; ST-04.2 analyze initial supported mixed document examples and extract available fields; ST-04.3 retain source associations, persist results, and expose unreadable/missing/ambiguous information.

**Acceptance:** Initial fixture values and account/source associations match expected outcomes; supported document types coexist without sorting; failures are visible; originals remain unchanged.

**Dependencies:** BL-03; Q-01, Q-02, and relevant Q-04/Q-08 decisions. Add OCR here if required for the initial fixture set.

### BL-05 Suggest explainable matches and expose result classes — R-02

**Trace:** FR-05 and FR-06; US-05 and US-06.

**Subtasks:** ST-05.1 apply agreed deterministic matching rules; ST-05.2 show evidence, conflicts, and result classes; ST-05.3 persist the relevant results and verify repeatability.

**Acceptance:** The initial fixture has expected reliable, uncertain, and unmatched cases; repeat runs with identical inputs/rules give identical suggestions; unresolved competing evidence remains visible.

**Dependencies:** BL-04; Q-03 through Q-05 decisions affecting suggestions and classification.

### BL-06 Correct associations and review progress — R-02

**Trace:** FR-07, FR-09, and FR-11; US-07, US-09, and US-10.

**Subtasks:** ST-06.1 assign, replace, and remove document associations; ST-06.2 represent manual processing under the agreed status policy; ST-06.3 update the summary and verify saved corrections after restart.

**Acceptance:** Corrections change associations and summary counts consistently and survive save/reopen; summary handling of manual/matched/unmatched overlap follows the approved model.

**Dependencies:** BL-05; Q-03, Q-05, and relevant Q-06 decisions.

### BL-07 Export the first complete reconciliation — R-02

**Trace:** FR-10; US-11; NFR-01 through NFR-04.

**Subtasks:** ST-07.1 select eligible associations and derive names under the agreed transaction naming policy; ST-07.2 copy documents and report success, skips, and failures; ST-07.3 demonstrate import, analysis, matching, correction, save/reopen, summary, and export together.

**Acceptance:** Expected renamed copies can be traced to their transactions; originals remain unchanged; the agreed collision policy protects original paths and handles existing targets. The complete initial scenario runs offline on Windows and Linux.

**Dependencies:** BL-06; Q-05 and Q-07 resolved; accepted export safeguards. This is the first end-to-end milestone, before broader coverage.

## EP-03 — Complete MVP coverage

### BL-08 Complete agreed input and repeat-processing coverage — R-03

**Trace:** FR-01 through FR-04 and FR-09; US-01 through US-04 and US-09.

**Subtasks:** ST-08.1 cover remaining agreed formats/layouts and OCR where approved; ST-08.2 verify multiple statements/accounts and approved duplicate handling; ST-08.3 handle source changes/reanalysis under approved preservation rules.

**Acceptance:** The full supported fixture matrix retains correct account/source associations; unsupported and failed files remain visible; duplicate/reanalysis/source-change behavior satisfies the agreed policies and preserves manual work where A-02/A-03 are accepted.

**Dependencies:** BL-07; Q-01, Q-02, Q-04, Q-06, and Q-08 decisions for this scope. Matching and export are rechecked when new input cases affect them.

### BL-09 Support manual document groups throughout the workflow — R-03

**Trace:** FR-07 through FR-11; US-07 through US-11.

**Subtasks:** ST-09.1 assign/remove individual group members and expose relevant amount differences; ST-09.2 preserve groups and correct summary counts across restart; ST-09.3 export group members under agreed naming/conflict rules.

**Acceptance:** Several documents can support one transaction without losing individual associations; group differences remain reviewable; save/reopen and export retain the approved behavior. No automatic grouping or conversion is presumed.

**Dependencies:** BL-07; Q-03 through Q-05 and Q-07 decisions. BL-08 is completed first under the proposed sequential roadmap.

## EP-04 — Reliable MVP acceptance

### BL-10 Verify full workflow, failures, and platform delivery — R-04

**Trace:** FR-01 through FR-11; US-01 through US-11; NFR-01 through NFR-06.

**Subtasks:** ST-10.1 verify the complete accepted fixture matrix including ambiguity, missing information, refunds, approved currency/group cases, repeat imports, and manual correction; ST-10.2 exercise approved save/source/export failure and collision behavior; ST-10.3 validate offline/local operation, original-file integrity, agreed workloads, and platform distribution; ST-10.4 review acceptance gaps and dependency/architecture commitments.

**Acceptance:** Agreed outcomes pass on supported Windows/Linux targets; originals remain unchanged on success and failure; summary/export match stored decisions; required safeguards and agreed performance targets pass. Unresolved failures or scope gaps prevent an unqualified MVP completion claim.

**Dependencies:** BL-08 and BL-09; Q-09 and Q-12 acceptance targets, plus all remaining decisions required by the accepted scope.

## Coverage and sequencing

FR-01–FR-04: BL-04/BL-08. FR-05–FR-06: BL-05. FR-07: BL-06/BL-09. FR-08: BL-09. FR-09: BL-03 and persistence checks in later stories. FR-10: BL-07/BL-09. FR-11: BL-06/BL-09. NFR-01–NFR-04 apply throughout; NFR-05–NFR-06 are addressed in BL-02 and reviewed in BL-10.

Proposed order: BL-01 → BL-02 → BL-03 → BL-04 → BL-05 → BL-06 → BL-07 → BL-08 → BL-09 → BL-10. Dependencies describe readiness; they do not authorize concurrent work or bypass user approval gates. Future backlog expansion or new documentation requires the applicable approval.
