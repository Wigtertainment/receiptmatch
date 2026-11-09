## Development Philosophy

ReceiptMatch is an independent open-source project.

- Design the product, architecture, data models, matching algorithms, and user experience based on our own requirements.
- Do not use existing receipt reconciliation applications as references, templates, or architectural foundations.
- Prefer established, actively maintained, well-tested open-source libraries for common technical functionality.
- Do not reinvent functionality already reliably provided by mature libraries.
- Evaluate dependencies based on maintainability, security, performance, documentation, and license compatibility.
- Keep the architecture modular, extensible, and as simple as reasonably possible.
- Avoid unnecessary abstractions, premature optimization, and overengineering.
- Document significant technical decisions and their trade-offs.
- Prioritize correctness, reliability, privacy, and maintainability over implementation speed.

## Jira workflow

- Use the ReceiptMatch Jira project (`REC`) as the implementation backlog.
- Create the agreed implementation ticket before coding. Each ticket branch starts from `main` and uses `EK/<TICKET>-<english-description>`.
- Read available transitions before changing status. The current workflow contains `To Do`, `In Progress`, `DevReview`, `Merged`, and `Done`.
- Create merge requests only after explicit user acceptance and a separate request to create them. Titles and descriptions are English; use the appropriate `DevReview` transition when a merge request is created.
- Set `Merged` only after the actual merge unless the user explicitly directs otherwise. Merge and deployment require separate authorization.
- Keep tickets and comments concise. Do not include phases, test descriptions, or test results. Do not post progress comments; add a short completion comment only when an important decision needs recording.
