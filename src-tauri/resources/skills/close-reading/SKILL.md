---
name: close-reading
description: Perform in-depth close reading on a specified PDF page range or document chapter, extract structured claims and boundary conditions, and draft concept notes or visual canvas nodes.
version: 1.0.0
---

# Close Reading

Use this skill when reading a designated chapter, paper section, or PDF page range to extract core scholarly propositions, identify scope boundary conditions, and create structured zettelkasten notes or canvas representations.

## Core Principles

1. **Bounded Reading & Chunking**:
   - Never ingest an entire multi-hundred page book in a single prompt. Process in bounded windows of 5 to 15 pages using `read_source_range` to prevent context pollution and truncation hallucinations.
2. **Propositions & Boundary Conditions**:
   - Every extracted claim MUST include its qualifying boundary conditions (`conditions` field) such as model assumptions, experimental constraints, historical context, or population scope.
3. **Preserve Locators & Quotes**:
   - Each claim must be linked to its exact source locator (`#page=N` or `#L100-L140`) and a concise verbatim excerpt verified via `verify_quote`.

## Execution Phases

### Phase 1: Establish Reading Scope & Research Context
1. Identify target file path (e.g. `sources/kahneman2011.pdf`) and page boundaries (`start_page: 20, end_page: 35`).
2. If linked to an active research project, call `get_research_state` to retrieve current project questions, unresolved problems, and next steps to guide extraction focus.
3. Use `todo_write` to outline the close-reading phases (e.g., "1. Inspect pages 20-27", "2. Extract core theses", "3. Map concept relationships").

### Phase 2: Read Passages & Formulate Claims
1. Call `read_source_range` to retrieve raw text segments for each window.
2. Formulate 3 to 5 atomic claims from the text:
   - **Title**: Clear, declarative title (e.g., "System 1 Operates Automatically Without Volition").
   - **Statement**: 1-2 sentence core thesis.
   - **Conditions & Scope**: Limitations under which the thesis holds (e.g., "Under normal cognitive load without deliberate override").
   - **Evidence Excerpt**: Key supporting sentence with page locator.

### Phase 3: Project Integration & Visual Planning
1. If working within a research project, call `update_research_state` to associate newly created claims and update unresolved questions.
2. Call `knowledge_canvas_plan` to propose a visual layout connecting the core concept, supporting claims, and open questions as connected cards on an idea canvas.

### Phase 4: Deliver Reading Summary
Provide the user with:
1. **Executive Synthesis**: Central argument of the analyzed passage.
2. **Structured Claims Table**: Listing titles, conditions, page references, and evidence quotes.
3. **Suggested Next Steps**: Unresolved questions raised by the text and recommended follow-up readings.
