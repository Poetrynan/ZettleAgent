---
type: literature
tags: [AI, NLP, machine-learning]
created: 2024-12-07
---

# Transfer Learning

Transfer Learning applies knowledge learned from one task to a **different but related** task.

## Core Idea

> "Don't start from scratch. Stand on the shoulders of giants."

In NLP, this means:

1. **Pre-training**: Learn language knowledge on massive unlabeled text
2. **Fine-tuning**: Adapt to specific tasks on smaller labeled datasets

## Milestones

```
Word2Vec (2013) → ELMo (2018) → BERT/GPT (2018-2019) → Large Model Era
   Word vectors     Contextualized     Pre-train+Fine-tune    Emergence
```

Each step was driven by the \[\[Transformer Architecture]] and increasing compute scale.

## Levels of Transfer

1. **Feature Transfer**: Reuse lower-level features (e.g., \[\[BERT]] embedding layers)
2. **Model Transfer**: Reuse entire pre-trained models
3. **Knowledge Transfer**: \[\[GPT Series]] In-context Learning — no fine-tuning needed

## Connection to Zettelkasten

Knowledge transfer in the \[\[Zettelkasten Method]]:

* Concepts learned in domain A are transferred to domain B via **cross-references**

* "The best ideas come from the collision of different fields" — this is the essence of transfer learning

## References

* \[\[Emergence]] — Transfer learning at scale leads to emergence

* \[\[Retrieval-Augmented Generation]] — An alternative knowledge injection method

<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->

