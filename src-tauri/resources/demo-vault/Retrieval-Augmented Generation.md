---
type: permanent
tags: [AI, RAG, search]
created: 2024-12-05
---

# Retrieval-Augmented Generation

RAG (Retrieval-Augmented Generation) combines **search-first, generate-second** to ground LLM responses in real data.

## Why RAG?

LLMs have two fundamental pain points:
1. **Knowledge cutoff**: Training data has a temporal boundary
2. **Hallucination**: Models "invent" plausible but incorrect information

RAG mitigates both by injecting **external context** at inference time.

## Workflow

```
User Query → Vectorize → Retrieve Relevant Docs → Build Prompt → LLM Generates Answer
                ↑                                                      |
                └── Embedding Model (e.g., BERT-derived)               ↓
                                                               Answer with Sources
```

## Retrieval Strategies

| Strategy | Principle | ZettelAgent Support |
|----------|-----------|---|
| **FTS5** | SQLite full-text search, keyword matching | Default mode |
| **Vector** | Embedding cosine similarity | vec0 extension |
| **Hybrid** | FTS + vector weighted fusion | Hybrid mode |

## Complementing Knowledge Graphs

RAG excels at **semantic similarity** retrieval, while [[Knowledge Graphs]] excel at **relational reasoning**. Combining both is the future — GraphRAG.

## References

- [[BERT]] — Common embedding backbone
- [[Transformer Architecture]] — Underlying architecture
- [[Zettelkasten Method]] — RAG's philosophy mirrors the Zettelkasten index system

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
