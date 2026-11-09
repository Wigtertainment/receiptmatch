# ReceiptMatch Open Questions

Status: product decisions for review. “Blocking” means blocking the affected implementation or MVP commitment, not blocking preparation of this proposal. No answer below is assumed approved.

## Blocking decisions

| ID | Decision needed | Why it blocks work |
| --- | --- | --- |
| Q-01 | Which bank statement formats, banks/layouts, date/number conventions, and initial account/currency examples must the MVP support? Can representative authorized or synthetic examples and expected normalized transactions be supplied? | Defines a usable import scope and its acceptance fixtures; universal format support is not feasible. |
| Q-02 | Which supporting-document formats and layouts are required? Must the MVP process image-only PDFs and image files using local OCR, and in which languages? | Determines extraction scope and whether an MVP without OCR would serve the intended documents. |
| Q-03 | Must a document be assignable to multiple transactions, or is one transaction per document sufficient initially? Which partial payments, bundled payments, credit notes, and over/underpayments need manual support? | Defines association semantics, conflict behavior, and group acceptance. Multiple documents for one transaction are already required. |
| Q-04 | Which date fields, amount meanings, date/amount tolerances, refund signs, fees, and currency comparisons are acceptable? How should mixed-currency groups be reviewed without automatic conversion? | Determines normalization and matching correctness. No fixed tolerances or conversion rules are approved. |
| Q-05 | What evidence makes a result reliable or uncertain? Does a reliable suggestion require confirmation before export? What does “manually processed” mean, including transactions intentionally left without a receipt, and how does it overlap with matched/unmatched? | Defines matching acceptance, review actions, export eligibility, and summary counts. |
| Q-06 | How should overlapping statements, repeated imports, and duplicate document copies be identified and handled? How should reanalysis interact with manual corrections? | Avoids duplicate reconciliation and loss of accepted work; a proposed preservation rule appears in A-02. |
| Q-07 | Which transaction fields and structure should exported names use? How should groups, identical names, existing targets, repeated exports, and partial failures behave? Can the source directory also be selected as the export destination? | Required to accept renamed-copy export without inventing accountant conventions or destructive overwrite behavior. |

## Non-blocking decisions for initial planning

These can remain open while requirements are reviewed, but must be resolved before implementing or accepting the affected feature.

| ID | Decision needed | Affected work |
| --- | --- | --- |
| Q-08 | Should folder analysis recurse? Are documents referenced in place or copied into a workspace? What should happen when source files move or change, and is user-assisted relinking required? | Discovery and long-lived workspaces; original files must always be preserved. |
| Q-09 | What representative workload, processing responsiveness, target Windows/Linux versions, and distribution expectations should define MVP acceptance? | Performance and platform validation; no arbitrary volume or timing promises are made. |
| Q-10 | May users edit extracted transaction/document fields, or only correct associations initially? Which language and locale should the initial interface use? | Review workflow and usability scope. |
| Q-11 | Is explicit save sufficient initially, or are autosave, crash recovery, backup/export of workspaces, or local encryption required? What diagnostic data may be retained locally? | Persistence and privacy details beyond the required local save/resume workflow. |
| Q-12 | What evidence should demonstrate reduced manual effort and acceptable match quality on the agreed sample set? | Measurable product success; coverage and correctness must be assessed without claiming unvalidated precision targets. |

## Reasonable initial assumptions and proposed safeguards

These are proposals for approval, not additional settled requirements.

| ID | Proposal | Consequence if revised |
| --- | --- | --- |
| A-01 | A local workspace organizes each reconciliation activity; multi-user collaboration and cloud synchronization are excluded from the proposed MVP. | Shared or synchronized work would expand persistence and conflict requirements. |
| A-02 | Duplicate import and reanalysis should never silently replace confirmed manual associations; conflicting new evidence should remain reviewable. | Any replacement policy needs explicit user interaction and acceptance criteria under Q-06. |
| A-03 | Unavailable or changed source files should be reported, with saved reconciliation decisions retained; portable source copies and relinking are not assumed. | Copying or relinking requirements would add workspace-management scope under Q-08. |
| A-04 | Export should preserve existing destination files and require an explicit resolution for collisions; failures should be reported per affected document. | The final policy may choose skip, alternate names, or an explicit user-approved replacement, but must preserve originals. |
| A-05 | The first complete workflow can use a deliberately small agreed fixture set; all required supported formats and multiple-account cases must be covered before MVP acceptance. | Broader initial coverage changes sequencing, not the final agreed acceptance scope. |
| A-06 | Manual grouping satisfies initial multiple-document support; automatic group discovery and automatic currency/fee allocation can be deferred. | Automatic handling would add matching rules, explanations, and acceptance cases. |

## Decisions deliberately reserved for later

Architecture specialists must evaluate Electron and Tauri after approval to begin that work. Angular and TypeScript remain preferences; SQLite remains a persistence candidate. Dependency selection, technical data models, matching implementation, and packaging are not finalized in Phase 1. Significant decisions and trade-offs should be documented when made; no additional documentation files are authorized by this proposal alone.
