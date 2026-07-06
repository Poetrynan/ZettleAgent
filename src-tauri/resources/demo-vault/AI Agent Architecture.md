---
type: permanent
tags: [AI, agent, architecture]
created: 2024-12-10
---

# AI Agent Architecture

An AI Agent is an intelligent system capable of **autonomous perception, reasoning, and action**.

## Core Loop

```
Perceive → Reason → Act → Observe → Loop
```

This fundamentally differs from the traditional "input → output" paradigm: Agents have **tool usage** and **multi-turn iteration** capabilities.

## Key Components

### 1. Brain (LLM)
- [[GPT Series]] Function Calling
- [[Transformer Architecture]] provides reasoning capability

### 2. Tools
- Search notes, read files, create content
- External API calls (via MCP protocol)

### 3. Memory
- **Short-term**: Conversation context window
- **Long-term**: Persisted to database. See [[Cognitive Load Theory]]
- **External**: [[Knowledge Graphs]] + vector databases

### 4. Planning
- ReAct: Alternating reasoning and action
- Chain-of-Thought: Step-by-step reasoning. See [[Emergence]]

## ZettelAgent's Implementation

ZettelAgent uses a **ReAct pattern** with a **10-round tool calling limit**:

1. User asks a question
2. LLM decides which tool to call
3. Tool executes, returns results
4. LLM decides whether to call another tool or respond to the user
5. Maximum 10 iterations to prevent infinite recursion

This enables AI to not just "answer questions" but truly "operate your knowledge base."

<!-- @generated -->
## Suggested Connections

- [[GPT Series]] (depends_on)
- [[Knowledge Graphs]] (depends_on)
- [[Zettelkasten Method]] (exemplifies)
- [[Cognitive Load Theory]] (supplementary)
<!-- /@generated -->
<!-- @generated -->
**Note Type**: `permanent`
<!-- /@generated -->
