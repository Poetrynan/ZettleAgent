---
name: inbox-triage
description: Triage inbox notes and raw clippings, detect near-duplicate notes and entity aliases, and draft safe, auditable reorganization plans.
version: 1.0.0
---

# Inbox Triage

Use this skill when processing accumulated web clippings, quick inbox fleethings, and unfiled notes to eliminate redundancy, discover terminology aliases, and produce an auditable consolidation plan.

## Core Principles

1. **Read-Only Plan First**:
   - Similarity does not imply equivalence. All merges, renames, and deletions must be presented as a reviewable plan first. Never overwrite or merge files without explicit human confirmation.
2. **Preserve Provenance & Backlinks**:
   - When proposing to merge two notes, ensure source URLs, timestamps, author metadata, and incoming wikilinks are preserved rather than lost.
3. **Auditable ChangeSets**:
   - Any approved modifications must execute through the ChangeSet engine to ensure full rollback capabilities.

## Execution Phases

### Phase 1: Survey Candidate Notes
1. Call `list_notes` on the specified folder (e.g. `_inbox/` or unfiled tags).
2. If no folder is specified, scan for orphan notes lacking incoming or outgoing wikilinks.

### Phase 2: Detect Duplicate Groups
1. Call `find_duplicate_groups` to scan the vault or target folder:
   - Identify exact duplicate notes (`match_kind: "exact"`).
   - Identify near-duplicate notes with substantial lexical similarity (`match_kind: "lexical_similarity"`, score $\ge 0.75$).
2. Inspect line differences and incoming backlink counts to determine which note is the preferred canonical card.

### Phase 3: Resolve Entity Aliases
1. Call `resolve_entity_aliases` to identify terminology variations across languages, acronyms, and synonyms (e.g., "FSRS", "Free Spaced Repetition Scheduler", "间隔重复").
2. Formulate canonical alias recommendations or frontmatter tag unifications.

### Phase 4: Deliver Triage Plan
Present the user with an actionable triage summary:
1. **Deduplication Candidates**: Pairs/groups of duplicate notes with diff summaries and recommendation on which card to keep.
2. **Alias Unification**: Suggested entity alias links to add.
3. **Graph Integration**: Suggestions for connecting orphaned cards to relevant Maps of Content (MOCs) or active research projects.
4. **Execution Prompt**: Ask the user which specific actions to execute via ChangeSet.
