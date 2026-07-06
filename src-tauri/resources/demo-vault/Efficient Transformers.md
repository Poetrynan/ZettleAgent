---
type: permanent
tags: [AI, transformer, efficiency, attention]
created: 2026-06-25
---

# Efficient Transformers

[[Efficient Transformers]] are methods for reducing the computational and memory cost of Transformer models while preserving as much capability as possible. They are important because standard self-attention scales quadratically with sequence length, making very long contexts and large models expensive to train and run.

## Motivation

The [[Attention Mechanism]] is powerful because it lets a model compare each token with many other tokens. However, this flexibility has a cost:

- Time complexity grows quickly as context length increases.
- Memory usage rises when storing attention matrices and intermediate activations.
- Large models become expensive to train, fine-tune, and deploy.

[[Scaling Laws]] show that increasing scale improves capability, but they also make efficiency more important: larger models and longer contexts require practical ways to reduce compute.

## Main Families

### Sparse Attention

[[Sparse Attention]] reduces the number of token-to-token comparisons by restricting attention to selected positions, such as local windows, strided positions, or learned sparse patterns. This can make long-context modeling more practical.

### Flash Attention

[[Flash Attention]] is a hardware-aware implementation strategy. It computes attention exactly but reorganizes memory access to reduce expensive reads and writes. Its main contribution is making attention faster and more memory-efficient on modern accelerators.

### Approximate and Structured Attention

Other approaches approximate full attention or impose structure on the attention pattern, such as linear attention, low-rank attention, kernel-based attention, or block-sparse attention. These methods trade some exactness or flexibility for lower computational cost.

## Relationship to Transformer Architecture

[[Efficient Transformers]] refine [[Transformer Architecture]] rather than replace it. They keep the core Transformer idea — attention-based information routing — but optimize how attention is computed or approximated.

## Relationship to Large Language Models

Efficient Transformers are especially relevant for [[GPT Series]] models because decoder-only LLMs often process long sequences and require repeated attention computation during generation. Efficiency improvements can lower training cost, inference latency, and deployment barriers.

## References

- [[Attention Mechanism]] — Core component being optimized
- [[Transformer Architecture]] — Architecture being made more efficient
- [[Scaling Laws]] — Larger scale increases the need for efficiency
- [[GPT Series]] — Large autoregressive models that benefit from efficient attention
- [[Natural Language Processing]] — Main application area for long-context Transformers

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
