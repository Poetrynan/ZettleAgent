---
type: permanent
tags: [AI, LLM, scaling, emergence]
created: 2026-06-25
---

# Scaling Laws

[[Scaling Laws]] describe predictable relationships between model capability and scale variables such as model size, dataset size, compute budget, and training duration. In large language models, they explain why increasing scale often produces smooth, measurable improvements and sometimes enables qualitatively new abilities.

## Core Idea

The central claim is not merely “bigger is better,” but that performance changes follow regular patterns as key resources increase:

- Larger models can store and compose more representations.
- More training data exposes the model to more linguistic, factual, and reasoning patterns.
- More compute allows longer or larger-scale optimization.
- These increases interact, making scale a central variable in modern LLM capability.

In this sense, [[Scaling Laws]] provide a quantitative framing for the [[GPT Series]] philosophy that “scale is all you need.”

## Relationship to Emergence

[[Scaling Laws]] help explain why [[Emergence]] appears in large models. Some capabilities improve gradually, while others become visible only after crossing a capability threshold. The law-like behavior is often continuous, but the observed behavior can look discontinuous when a task requires a minimum level of competence.

This mirrors the Zettelkasten analogy in [[Emergence]]: a small number of notes may remain isolated, while a larger network begins to generate unexpected connections.

## Relationship to Transformers

[[Scaling Laws]] depend on the architectural substrate provided by [[Transformer Architecture]]. Transformers are effective scaling targets because self-attention and parallelizable computation allow models to be trained at very large sizes.

They also rely on [[Attention Mechanism]], since attention gives large models a flexible way to route information across tokens, contexts, and representations.

## Implications

- **Capability forecasting**: Scaling laws help estimate what model size or compute budget may be needed for a target performance level.
- **Research strategy**: They justify investing in larger models, larger datasets, and more efficient training.
- **Limits and tradeoffs**: Scaling improves many capabilities, but it does not automatically solve issues such as factual reliability, reasoning errors, alignment, or cost efficiency.
- **Efficiency pressure**: Because scaling can be expensive, it motivates work on [[Efficient Transformers]] and other methods that preserve capability while reducing compute.

## References

- [[GPT Series]] — Why bigger models work better
- [[Emergence]] — Quantitative change can trigger qualitative transformation
- [[Transformer Architecture]] — Scalable architecture that enables modern LLMs
- [[Attention Mechanism]] — Core routing mechanism inside Transformers
- [[Efficient Transformers]] — Methods for making large-scale attention practical

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
