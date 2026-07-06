---
type: permanent
tags:
  - AI
  - NLP
  - Google
created: 2024-12-04
---
# BERT

BERT (Bidirectional Encoder Representations from Transformers) is Google's **bidirectional** pre-trained model.

## BERT vs GPT

| Feature      | BERT                               | \[\[GPT Series]]               |
| ------------ | ---------------------------------- | ------------------------------ |
| Direction    | Bidirectional                      | Left-to-right                  |
| Pre-training | MLM + NSP                          | Autoregressive LM              |
| Architecture | Encoder-only                       | Decoder-only                   |
| Strengths    | Understanding (classification, QA) | Generation (writing, dialogue) |

## Key Innovation

**Masked Language Model (MLM)**: Randomly masks 15% of tokens and trains the model to predict them. This forces the model to learn **bidirectional context** — understanding words from both left and right.

## Legacy

BERT sparked an arms race in NLP pre-trained models:

* RoBERTa — More data, longer training

* ALBERT — Parameter sharing, smaller and faster

* DeBERTa — Disentangled attention, by Microsoft

All of these are built on the Encoder portion of the \[\[Transformer Architecture]].

## Role in RAG

BERT-family models are widely used as **embedding models** (e.g., `bge-large`, `e5`), powering the semantic vector search behind \[\[Retrieval-Augmented Generation]]. ZettelAgent's vector search feature is built on this principle.

<!-- @generated -->

**Note Type**: `permanent`

<!-- /@generated -->
