---
type: permanent
tags: [AI, deep-learning, architecture]
created: 2024-12-01
---

# Transformer Architecture

The Transformer is the foundation of modern large language models, introduced by Vaswani et al. in the landmark 2017 paper "Attention Is All You Need."

## Core Mechanisms

- **Self-Attention**: Allows the model to attend to all positions in the input sequence when processing each token. See [[Attention Mechanism]]
- **Multi-Head Attention**: Runs multiple attention functions in parallel, capturing information from different representation subspaces
- **Positional Encoding**: Since the model contains no recurrence, position information must be explicitly injected

## Impact

The Transformer gave rise to two major branches — [[GPT Series]] and [[BERT]] — fundamentally reshaping the [[Natural Language Processing]] landscape.

Its "pre-train then fine-tune" paradigm also profoundly influenced how [[Transfer Learning]] is applied in NLP.

## Connection to Zettelkasten

The attention mechanism mirrors the cross-referencing philosophy of the [[Zettelkasten Method]] — every note can "attend to" any other node in the knowledge network.

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
