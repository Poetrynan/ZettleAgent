---
name: perspective-compare
description: Compare contrasting or complementary viewpoints across different literature, scholars, or notes, map supporting and opposing evidence, and analyze underlying assumption discrepancies.
version: 1.0.0
---

# Perspective Compare

Use this skill to compare competing academic theories, contrasting research findings, or divergent viewpoints across multiple literature sources or vault notes on a single topic.

## Core Principles

1. **Avoid Oversimplified Binary Judgment**:
   - Scholarly disagreements usually stem from distinct baseline assumptions, differing methodological parameters, or divergent sample populations rather than simple true/false oppositions.
   - Seek to explain *why* the views differ rather than hastily declaring a winner.
2. **Bilateral Evidence Mapping**:
   - Systematically classify evidence into `supports` (supporting data/quotes) and `contradicts` (opposing or limiting evidence) linked to primary source coordinates.
3. **Trace Claim Dependencies**:
   - When one perspective challenges another, trace dependent concepts to reveal the broader epistemological implications.

## Execution Phases

### Phase 1: Identify Topic & Perspectives
- Define the debate topic (e.g. "Does caloric restriction extend primate lifespan?").
- Identify key literature and proponents (e.g., Perspective A: Wisconsin Study / Colman 2009 vs Perspective B: NIA Study / Mattison 2012).

### Phase 2: Retrieve & Analyze Primary Arguments
1. Call `compare_notes` to inspect existing vault cards if already summarized.
2. If working from raw sources, use `read_source_range` to pull the respective methodology and discussion sections.
3. Extract structured profiles for each side:
   - Central proposition.
   - Core empirical evidence and citations.
   - Preconditions and experimental parameters (e.g., diet composition, feeding regimen, age of onset).

### Phase 3: Trace Evidence & Impact Analysis
1. Call `trace_claim` to map dependencies and existing evidence records for each claim.
2. Call `preview_change_impact` to assess how accepting or superseding one claim would affect downstream notes and research projects across the vault.

### Phase 4: Deliver Comparison Matrix
Present a balanced, structured synthesis:
1. **Debate Overview**: Brief summary of the core disagreement.
2. **Comparison Matrix**:
   | Dimension | Perspective A | Perspective B |
   | :--- | :--- | :--- |
   | **Core Claim** | ... | ... |
   | **Primary Evidence** | Quote & Locator (`#page=X`) | Quote & Locator (`#page=Y`) |
   | **Key Preconditions** | E.g. Refined sucrose diet | E.g. Natural cereal diet |
   | **Status** | Confirmed / Disputed | Confirmed / Disputed |
3. **Synthesis & Open Questions**: How the apparent contradiction can be reconciled or what critical test remains unresolved.
