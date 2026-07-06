---
type: permanent
tags:
  - AI
  - attention
  - cognitive-science
created: 2024-12-02
---
# Attention Mechanism

The attention mechanism teaches models "where to look" and is the core component of the \[\[Transformer Architecture]].

## Mathematical Formulation

$\text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V$

The Query-Key-Value design draws inspiration from **information retrieval**: use a query to match keys and extract corresponding values.

## Cognitive Science Perspective

The human attention system has strikingly similar mechanisms:

* **Selective Attention**: The cocktail party effect, analogous to softmax selection in self-attention

* **Divided Attention**: Parallel processing across multiple streams, mirrored by multi-head attention. See \[\[Cognitive Load Theory]]

## &#x20;Variants

* **Cross-Attention**: Used in Encoder-Decoder architectures

* **Sparse Attention**: Reduces computational complexity. See \[\[Efficient Transformers]]

<br />

* **Flash Attention**: Hardware-aware exact attention algorithm

## Beyond NLP

The success of attention inspired Graph Attention Networks (GAT) in \[\[Knowledge Graphs]], enabling learned edge weights between nodes.

<!-- @generated -->
## Suggested Connections

* \[\[Transformer Architecture]] (supports)

* \[\[Natural Language Processing]] (supports)

* \[\[Knowledge Graphs]] (exemplifies)

* \[\[Cognitive Load Theory]] (supplementary)

* \[\[Zettelkasten Method]] (supplementary)
<!-- /@generated -->
<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
