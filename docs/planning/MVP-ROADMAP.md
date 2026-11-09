# ReceiptMatch MVP Roadmap

Status: proposed future development sequence. This roadmap is a planning artifact, not authorization to create tickets, select technologies, or implement features. Each later phase requires explicit approval; if a phase proves large, present its complete proposed subdivision before starting it.

## Sequence

| Phase | Scope and outcome | Verification and dependencies |
| --- | --- | --- |
| R-00 Product agreement | Review the five Phase 1 documents, confirm MVP boundaries and safeguards, and resolve blocking questions for the first delivery slice. | Approved requirements and expected fixture outcomes; Q-01 through Q-07 are answered before their affected features are committed. This is the current planning handoff. |
| R-01 Architecture evaluation | After separate approval, evaluate desktop options including Electron/Tauri, the Angular/TypeScript preference, local persistence including SQLite, and maintained libraries for the agreed formats. Define boundaries for importing, extraction, matching, review, persistence, and export. | A reviewable choice supports Windows/Linux, offline use, financial correctness, original protection, license compatibility, and the agreed examples. No technology is selected by this roadmap. Depends on R-00. |
| R-02 Early complete workflow | Build a thin local desktop workflow using the smallest agreed supported statement/document fixture set: import, normalize, analyze a mixed folder, produce explainable deterministic candidates, show result classes, manually correct a match, save/reopen, review summary, and export renamed copies. | Demonstrate the complete path on Windows and Linux with a match, an ambiguous candidate, an unmatched transaction, a manual correction, and unchanged originals. Exact formats, statuses, naming, and confirmation follow approved answers. Depends on R-01 and relevant product decisions. This proves the workflow, not full MVP coverage. |
| R-03 Complete input and association coverage | Extend to all agreed MVP statement/document formats and layouts, multiple statements/accounts, and manual multiple-document groups. Add OCR only if included by Q-02. Address approved duplicate/conflict behavior, source changes, and remaining extraction cases. | Supported fixture matrix verifies source/account associations, mixed documents, groups, currency/date semantics, repeat processing, and preserved manual work under the approved safeguards. Depends on R-02; acceptance is limited to the agreed scope. |
| R-04 Reliability and MVP acceptance | Complete approved failure handling, export collision behavior, summary consistency, local persistence guarantees, offline/privacy checks, workload validation, and distributable platform verification. | End-to-end acceptance satisfies FR-01 through FR-11 and NFR-01 through NFR-06; no original is altered/deleted, unresolved evidence stays visible, approved safeguards hold, and agreed workload/platform criteria pass. Depends on R-03. |

R-02 includes basic safe failure handling and original-file protection from the outset. R-04 validates and completes reliability across the full accepted scope; it does not defer essential data protection until the end.

## Scope control

- Deliver a working import-to-export path before broadening format coverage or adding advanced matching.
- Keep automatic group discovery, split-payment automation, currency/fee allocation, bank connections, accounting integrations, cloud collaboration, and optional local AI outside this proposed MVP.
- Resolve required manual treatment of financial edge cases before excluding behavior needed by the agreed examples.
- Do not treat a single supported fixture or a successful demonstration as evidence of universal parsing or match quality.
- Use [Backlog Draft](BACKLOG-DRAFT.md) to trace each proposed delivery item to [requirements](../requirements/PRD.md) and [user stories](../requirements/USER-STORIES.md).

## Phase 1 handoff gate

Review the proposed MVP, assumptions A-01 through A-06, questions Q-01 through Q-12, and this sequence. Stop after Phase 1. Jira creation, architecture evaluation, implementation, merges, and deployments each remain subject to their applicable explicit authorization.
