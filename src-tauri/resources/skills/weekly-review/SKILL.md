---
name: weekly-review
description: Audit knowledge graph evolution over the past week, summarize active research project milestones, assess downstream impact of changed facts, and plan review items.
version: 1.0.0
---

# Weekly Review

Use this skill at the end of a week or research cycle to audit vault evolution, summarize progress on active research projects, assess the impact of recently changed or disputed claims, and review spaced repetition items.

## Core Principles

1. **Synthesize into Existing Context**:
   - The weekly review should augment existing project logs or weekly journal entries rather than creating fragmented, isolated review notes.
2. **Impact & Dependency Awareness**:
   - Give special attention to claims modified, disputed, or superseded during the week. Check whether dependent notes or conclusions need revision.
3. **Close the Learning Loop**:
   - Surface active FSRS review cards and open questions to transform newly acquired notes into durable long-term knowledge.

## Execution Phases

### Phase 1: Establish Time Range & Vault Dynamics
1. Set the review window (defaults to the past 7 days).
2. Call `get_vault_stats` to compute note and relation growth metrics.
3. Call `get_timeline` to retrieve the stream of created, modified, and linked cards over the past week.

### Phase 2: Audit Research Projects & Claims
1. Call `get_research_state` across active research projects:
   - Identify questions resolved and sources ingested during the week.
   - Extract current `unresolved_questions` and `next_steps`.
2. Inspect claims marked as `disputed` or `superseded`:
   - Call `preview_change_impact` to identify downstream notes still citing obsolete assumptions.

### Phase 3: Spaced Repetition & Retention Check
1. For newly confirmed claims, call `generate_review_items` to generate evidence-backed review question drafts.
2. Note any overdue review cards scheduled in the FSRS review deck.

### Phase 4: Deliver Weekly Review Digest
Provide a structured report organized into:
1. **Knowledge Growth Metrics**: New notes, sources captured, and claims validated.
2. **Active Research Progress**: Summary of progress per research project with key breakthroughs.
3. **Claim Health & Impact Warnings**: Notes flagged for attention due to updated or challenged evidence.
4. **Next Week Priorities**: Consolidated list of unresolved questions to tackle next.
