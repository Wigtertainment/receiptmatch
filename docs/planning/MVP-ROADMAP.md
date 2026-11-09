# ReceiptMatch MVP Roadmap

Status: Phase 1 and Phase 2 accepted. R-02 subdivision and DEC-06 through DEC-11 approved. Subphase 3.1 / [REC-2](https://wigtertainment.atlassian.net/browse/REC-2) is implemented and verified, pending user acceptance, under [REC-1](https://wigtertainment.atlassian.net/browse/REC-1). Jira is the leading implementation backlog; 3.2 and later remain separately gated.

## Sequence

| Phase | Scope and outcome | Verification and dependencies |
| --- | --- | --- |
| R-00 Product agreement | Phase 1 documentation accepted; DEC-01 through DEC-05 remain approved. Representative fixtures and remaining MVP policies still need agreement. | Approved scope is separated from partially resolved/open Q-01 through Q-12; remaining blockers are answered before affected implementation/acceptance. |
| R-01 Architecture evaluation — Phase 2 | Software Architect followed by Desktop App Engineer completed the evaluation; the isolated validation passed 26 packaged checks and four runner checks on each of Windows x64 and Ubuntu 24.04 x64. | Results accepted by the user on 2026-11-09 within the documented limits. Product implementation, real bank-layout support, release installers, and unresolved product policies are not accepted by this technical validation. |
| R-02 Early complete workflow | Build a thin local desktop workflow using agreed text/scanned PDF statement and supporting-document fixtures: import, embedded-text/local-OCR extraction, normalize, explainable suggestions, separate confidence/approval, manual correction, batch approval, save/reopen, summary, approved document copies, and CSV report. | Demonstrate the complete path on Windows/Linux with ambiguity, unmatched/unresolved work, batch approval, and unchanged originals. No unapproved document copies; CSV represents open work. Layouts, detailed statuses, names, and CSV fields follow approved answers. Depends on R-01 approval/results and relevant product decisions. This proves the workflow, not full coverage. |
| R-03 Complete input and association coverage | Extend agreed PDF layouts, supporting-document formats and required local English OCR coverage, multiple statements/accounts, and manual multiple-document groups. Address approved duplicate/conflict behavior, source changes, and remaining extraction cases. | Fixtures verify source/account associations, mixed text/scanned documents, groups, currency/date semantics, separate confidence/approval, repeat processing, preserved manual work under approved safeguards, and both exports. Depends on R-02; no CSV/CAMT statement import or full partial-payment UI. |
| R-04 Reliability and MVP acceptance | Complete approved failure handling, document/CSV collision behavior, summary consistency, persistence, offline/privacy, workload validation, and distributable platform verification. | End-to-end acceptance satisfies FR-01 through FR-13 and NFR-01 through NFR-06; no original is altered/deleted, unresolved work stays visible, confidence never substitutes for approval, required OCR works locally, and agreed safeguards/workload/platform criteria pass. Depends on R-03. |

R-02 includes basic safe failure handling and original-file protection from the outset. R-04 validates and completes reliability across the full accepted scope; it does not defer essential data protection until the end.

## Approved R-02 subdivision

| Subphase | Scope and reason | Verification and gate |
| --- | --- | --- |
| 3.1 Product foundation | Secure Electron/Angular desktop shell, English UI, SQLite workspace lifecycle, explicit saving and dirty-state protection. BL-03 / FR-09 / US-09; REC-2. | Implemented: nine persistence/controller tests and nine packaged UI checks pass on each of Windows x64 and Ubuntu 24.04 x64. Independent review findings resolved; visible virtual-desktop UI checked. Pending user acceptance; no subsequent subphase started. |
| 3.2 Import and analysis | Agreed Revolut/Airwallex EUR layouts and PDF/PNG/JPEG documents; local English OCR and visible uncertainty. Supplies verified inputs. BL-04 / FR-01–FR-04. | Representative expected extraction and unchanged originals. Requires separate start approval and concrete layout examples. |
| 3.3 Matching and review | Deterministic suggestions, manual correction, batch approval, summary and resumed work. Makes associations reviewable before export. BL-05/BL-06. | Approved matching/revision rules, ambiguous/unmatched cases, and saved review decisions. Requires separate start approval. |
| 3.4 Export and complete workflow | Approved document copies, CSV and end-to-end offline path. Completes the first usable product workflow. BL-07. | Agreed naming/CSV details, safe collisions/partial outcomes and both platforms. Requires separate start approval. |

Only 3.1 is authorized and is now ready for acceptance. Each subphase is accepted before the next starts. Multiple-document UI and broader coverage remain R-03; foundation storage allows their later addition.

## Scope control

- Deliver a working import-to-export path before broadening format coverage or adding advanced matching.
- Keep CSV/CAMT/other statement imports, full partial-payment workflows/dedicated UI, and automatic split allocation outside the approved initial MVP. Preserve future format extensibility and many-to-many readiness.
- Keep automatic group discovery, currency/fee allocation, bank connections, accounting integrations, cloud collaboration, and optional local AI outside this proposed MVP.
- Resolve required manual treatment of financial edge cases before excluding behavior needed by the agreed examples.
- Do not treat a single supported fixture or a successful demonstration as evidence of universal parsing or match quality.
- Use [Backlog Draft](BACKLOG-DRAFT.md) to trace each proposed delivery item to [requirements](../requirements/PRD.md) and [user stories](../requirements/USER-STORIES.md).

## Phase 1 handoff gate

Phase 1 and Phase 2 results are accepted. DEC-01 through DEC-11 remain approved; unresolved portions of A-01 through A-06 and Q-01 through Q-12 remain visible. Phase 2 findings are in [Architecture Evaluation](../architecture/ARCHITECTURE-EVALUATION.md); subsequent work is limited to authorized subphase 3.1.

## Phase 2 architecture evaluation scope

Phase 2 corresponds to R-01. Software Architect and Desktop App Engineer evaluated the scope below sequentially. The user then authorized an isolated validation harness under `validation/architecture`, with English OCR and Ubuntu as the Linux target; product implementation remains outside this work.

| Role | Responsibility and evaluation scope | Expected reviewable results |
| --- | --- | --- |
| Software Architect | Define modular boundaries; evaluate Angular/TypeScript integration, local SQLite persistence, deterministic/explainable matching, future many-to-many-ready associations, and confidence separate from approval. Evaluate contracts for PDF/OCR results, review/batch approval, CSV reports, and safe document export without assuming unresolved product rules. | Architecture proposal with options/trade-offs, responsibilities and data flow, conceptual association/approval lifecycle, matching/extraction uncertainty handling, and traceability to requirements. No finished schema or implementation is required by this preparation. |
| Desktop App Engineer | Evaluate Electron versus Tauri with Angular/TypeScript; safe local filesystem access; representative PDF text extraction and local OCR libraries; resource/dependency bundling and Windows/Linux packaging; offline operation and desktop security boundaries. Coordinate integration and persistence constraints with the Software Architect. | Evidence-based desktop/runtime and library comparison, platform/OCR packaging requirements, filesystem/export risks, security constraints, and a verification plan covering representative text/scanned inputs and both platforms. |

Shared evaluation must cover PDF bank statement extraction/validation without universal-layout claims, local OCR and supporting-document extraction, deterministic matching, many-to-many readiness without full partial-payment UI, review/batch approval, CSV/report contracts and approved-only document export. Assess mature libraries by maintenance, security, performance, tests, documentation, and license compatibility, without competitor templates.

Evaluation handoff: an architecture recommendation with alternatives, unresolved product dependencies, security/offline/filesystem considerations, Windows/Linux packaging risks, and a testing plan covering extraction, matching, approval, persistence, and safe exports. The separately authorized result file distinguishes documentation evidence from experiments still needed.

**Approval boundary:** Phase 2 and its validation are accepted. The user approved 3.1 and Jira tracking; REC-2 is its implementation ticket. Later subphases, additional documentation files, merge-request creation, merges, and deployments require their applicable explicit authorization. Concrete bank-layout examples are still needed before 3.2.
