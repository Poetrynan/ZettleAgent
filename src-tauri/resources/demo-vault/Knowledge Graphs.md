---
type: permanent
tags: [graph, data-structures, knowledge-management]
created: 2024-12-06
---

# Knowledge Graphs

A Knowledge Graph represents entities and their relationships using a **node + edge** graph structure.

## Core Concepts

- **Nodes**: Entities or concepts, e.g., "Transformer", "GPT-4"
- **Edges**: Relationships, e.g., "based on", "cites", "contrasts with"
- **Properties**: Metadata on nodes and edges

## Implementation in ZettelAgent

ZettelAgent automatically builds a knowledge graph from Markdown wikilinks:

```
[[Transformer Architecture]] --spawned--> [[GPT Series]]
[[Transformer Architecture]] --spawned--> [[BERT]]
[[GPT Series]] <--contrasts--> [[BERT]]
[[Zettelkasten Method]] --inspired--> [[AI Agent Architecture]]
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Storage | SQLite + `note_relations` table |
| Layout | Force-directed + Barnes-Hut quadtree |
| Community Detection | Union-Find algorithm |
| Rendering | Canvas 2D + Bezier curves |

## Intersection with AI

- [[Attention Mechanism]] → Graph Attention Networks (GAT)
- [[Retrieval-Augmented Generation]] + Knowledge Graphs = GraphRAG
- [[Emergence]] — Pattern discovery in large-scale graphs

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
