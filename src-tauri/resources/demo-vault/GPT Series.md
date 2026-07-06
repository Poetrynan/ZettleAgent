---
type: permanent
tags: [AI, LLM, OpenAI]
created: 2024-12-03
---

# GPT Series

GPT (Generative Pre-trained Transformer) is OpenAI's family of autoregressive language models.

## Evolution

| Model | Parameters | Released | Key Breakthrough |
|-------|-----------|----------|-----------------|
| GPT-1 | 117M | 2018.06 | Pre-train + fine-tune paradigm |
| GPT-2 | 1.5B | 2019.02 | Zero-shot capability emergence |
| GPT-3 | 175B | 2020.05 | Few-shot / In-context Learning |
| GPT-4 | ~1.8T (MoE) | 2023.03 | Multimodal + reasoning leap |

## Core Philosophy

GPT's thesis is "**scale is all you need**" — intelligence emerges from scaling model size, data, and compute. See [[Emergence]].

This stands in sharp contrast to [[BERT]]'s bidirectional encoding approach: GPT chose **unidirectional autoregression**.

## Connection to Agents

GPT-4's Function Calling capability enables LLMs to serve as the "brain" of an Agent, invoking external tools to complete tasks. This is precisely the foundation of ZettelAgent's [[AI Agent Architecture]].

## References

- [[Transformer Architecture]] — Underlying architecture
- [[Transfer Learning]] — Theoretical basis for pre-training
- [[Scaling Laws]] — Why bigger models work better

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
