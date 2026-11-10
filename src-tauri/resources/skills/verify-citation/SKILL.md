---
name: verify-citation
description: Trace and verify quotes or factual claims against primary sources, distinguish verbatim quotes from translations and paraphrases, and locate exact passages with line and physical page numbers.
version: 1.0.0
---

# Verify Citation

Use this skill when the user asks to verify whether a quote, passage, or scholarly assertion genuinely originates from a specific author, book, paper, or historical source (e.g. "Did Niklas Luhmann really say this?").

## Core Principles

1. **Strict Distinction of Quote Kinds**:
   - If the user provides a quote in Chinese or English, but the original author wrote in German, French, or Latin, the quote is a **translation** or **paraphrase**.
   - NEVER classify a translated or paraphrased sentence as an `exact` verbatim match without locating the primary original text.
   - Any quote verification must explicitly state whether it is `exact`, `normalized` (minor punctuation/casing differences), `approximate` (semantic paraphrase), `not_found`, or `unavailable`.
2. **Deterministic Source Anchoring**:
   - Always supply precise locators: physical 1-based PDF page numbers (`#page=N`), line numbers (`#L10-L25`), and content hashes.
   - Never invent or hallucinate citations, DOIs, publication years, or page numbers. If the primary text is absent from the vault or unreachable, return `not_found` or `unavailable`.
3. **ChangeSet Audit Safety**:
   - Saving evidence notes or updating knowledge claims must be performed transparently via the ChangeSet audit system, never silently overwriting user notes.

## Execution Phases

### Phase 1: Analyze the Claim & Query Elements
- **Target Quote**: The exact wording provided by the user.
- **Attributed Author/Work**: The claimed origin (e.g., Niklas Luhmann, *Soziale Systeme*, 1984).
- **Original Language**: Identify the primary language of the author and work.

### Phase 2: Locate or Capture the Primary Source
1. Search the local vault first using `search_notes` to see if the PDF, paper, or primary book notes are already indexed.
2. If the primary document is missing:
   - Use `resolve_reference` to look up verified bibliographic metadata by DOI, ISBN, or arXiv ID.
   - Use `web_search` to find reputable scholarly archives (Google Books, JSTOR, PhilPapers, university repositories).
3. Ingest the candidate document or web snapshot using `capture_source` into `_sources/` to obtain a persistent `source_id` and content checksum.

### Phase 3: Bounded Reading & Deterministic Quote Verification
1. Call `read_source_range` to inspect the candidate chapter or page segment (e.g., `start_page: 15, end_page: 30`).
2. Call `verify_quote` with the target quote and the appropriate `quote_kind` (`"original"`, `"translation"`, or `"paraphrase"`).
3. Evaluate the result:
   - If exact/normalized match: extract the snippet, physical page number, and locator.
   - If approximate: note the textual discrepancies between the user's wording and the author's original words.
   - If not found in the specified range: expand the search scope or declare the quote unverified.

### Phase 4: Structured Deliverable
Present the verification report in three distinct sections:
1. **Verification Verdict**: Clearly state whether the quote is a verified original quote, a faithful translation, a loose paraphrase, or an apocryphal/misattributed quote.
2. **Primary Evidence & Locator**: Display the author's primary text, publication details, and clickable locator (e.g., `sources/luhmann1981.pdf#page=15`).
3. **Recommended Actions**: Prompt the user whether they would like to register this verified evidence in the `ClaimsWorkspace` or link it to an existing concept note.
