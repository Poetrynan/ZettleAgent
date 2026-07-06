// P0-1: internal_tools is now a module directory.
// Tool definitions and dispatch live here; implementations are in sub-modules.

mod search_ops;
mod note_ops;
mod graph_ops;
mod web_ops;
mod canvas_ops;
pub(crate) mod workspace_ops;
pub(crate) mod helpers;

use crate::llm::{ToolDef, ToolFunction};
use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

pub fn get_internal_tool_defs() -> Vec<ToolDef> {
    vec![
        // 1. search_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "search_notes".to_string(),
                description: "Search the knowledge base for notes matching a query. Automatically uses hybrid search (FTS + vector) when embeddings are available, otherwise falls back to keyword-only FTS. Returns relevant text chunks with file paths and scores.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query text (keywords or regex pattern if regex=true)"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results to return (default 5)",
                            "default": 5
                        },
                        "folder": {
                            "type": "string",
                            "description": "Filter results to notes in this folder path (e.g. 'projects/' or 'daily/'). Optional."
                        },
                        "regex": {
                            "type": "boolean",
                            "description": "If true, treat query as a regex pattern and search raw content instead of FTS5. Default: false."
                        }
                    },
                    "required": ["query"]
                }),
            },
        },
        // 2. list_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "list_notes".to_string(),
                description: "List note files in the vault with their paths and titles. Supports folder filtering and sorting.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "folder": {
                            "type": "string",
                            "description": "Filter to notes in this folder path (e.g. 'projects/'). Optional."
                        },
                        "sort_by": {
                            "type": "string",
                            "enum": ["name", "date", "size"],
                            "description": "Sort order: 'name' (default), 'date' (newest first), 'size' (largest first)."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results (default 200, max 500)"
                        }
                    }
                }),
            },
        },
        // 3. read_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "read_note".to_string(),
                description: "Read the full content of a specific note file from the vault.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to read"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        // 4. get_graph
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_graph".to_string(),
                description: "Get a summary of the knowledge graph (up to 50 nodes, 100 edges — NOT the full vault). Each node includes: id, label, note_type, is_hub, is_orphan, chunk_count. Each edge includes: source, target, type (wikilink/semantic/supports/contradicts), label. Use for vault-wide structural overview. For the complete note list, use list_notes instead.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // 5. get_local_graph (KG-2: supports 1-3 hop depth)
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_local_graph".to_string(),
                description: "Get the neighborhood graph around a specific note with configurable depth (1-3 hops). Returns neighbor nodes with pagerank importance scores and edges with relationship types. Use depth=1 for direct connections, depth=2 to discover 'friends of friends', depth=3 for broader ecosystem exploration. Essential for understanding a note's context within the knowledge graph and discovering indirect connections.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to get the local graph for"
                        },
                        "depth": {
                            "type": "integer",
                            "description": "How many hops to traverse (1=immediate neighbors, 2=neighbors of neighbors, 3=3-hop). Default: 1",
                            "default": 1,
                            "minimum": 1,
                            "maximum": 3
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        // 6. find_shortest_path (KG-2: path discovery)
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "find_shortest_path".to_string(),
                description: "Find the shortest connection path between two notes in the knowledge graph. Returns the ordered chain of notes with relation types at each hop, or empty if no path exists. Core tool for relationship reasoning — use when user asks 'how are A and B related?', 'what connects these notes?', '这两篇笔记有什么关系？'. The returned path includes intermediate nodes and their relation types for explaining connection chains.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "source": {
                            "type": "string",
                            "description": "File path of the starting note"
                        },
                        "target": {
                            "type": "string",
                            "description": "File path of the destination note"
                        }
                    },
                    "required": ["source", "target"]
                }),
            },
        },
        // 7. run_lint
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "run_lint".to_string(),
                description: "Run a comprehensive health check on the knowledge base. Returns: orphan_notes, broken_links, missing_metadata, graph_health (connected_components, largest_component_size, fragmentation%, hub_overload nodes with >20 edges, unidirectional relations, missing_embeddings count), semantic_duplicates (notes with ≥92% embedding similarity that may need merging), and hidden_connections (semantically similar notes ≥75% with no existing links). Use for vault diagnostics, graph quality assessment, identifying structural issues, and discovering semantic insights.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // 8. get_timeline
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_timeline".to_string(),
                description: "Get the timeline of note changes. Can be filtered by note path or number of days.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": {
                            "type": "string",
                            "description": "Optional: filter timeline to a specific note"
                        },
                        "days": {
                            "type": "integer",
                            "description": "Optional: number of days to look back (default 30)",
                            "default": 30
                        }
                    }
                }),
            },
        },
        // 9. create_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "create_note".to_string(),
                description: "Create a new note file in the vault with the given content. Use 'workspace' to specify which workspace folder to create the note in (use list_workspace_folders to see available folders). SENSITIVE: requires user approval.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path for the new note (relative to the target workspace root, e.g. 'ideas/new-idea.md')"
                        },
                        "content": {
                            "type": "string",
                            "description": "The markdown content for the new note"
                        },
                        "workspace": {
                            "type": "string",
                            "description": "Optional. The workspace folder index (e.g. '0', '1') or absolute path to specify which workspace to create the note in. Defaults to the primary workspace (index 0). Use list_workspace_folders to discover available workspaces."
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        // 10. edit_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "edit_note".to_string(),
                description: "Edit an existing note file, replacing its content entirely. Only use when you need to rewrite the whole note. For partial edits, prefer patch_note.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to edit"
                        },
                        "content": {
                            "type": "string",
                            "description": "The new markdown content for the note"
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        // 11. patch_note (precision search-replace editing)
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "patch_note".to_string(),
                description: "Precisely edit parts of an existing note using search-and-replace. Provide the exact text to find and its replacement. This preserves the rest of the note content. Prefer this over edit_note for partial modifications.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to patch"
                        },
                        "patches": {
                            "type": "array",
                            "description": "List of search-replace operations to apply in order",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "search": {
                                        "type": "string",
                                        "description": "Exact text to find in the note (must match precisely, including whitespace and newlines)"
                                    },
                                    "replace": {
                                        "type": "string",
                                        "description": "Text to replace the found match with. Use empty string to delete."
                                    },
                                    "replace_all": {
                                        "type": "boolean",
                                        "description": "If true, replace ALL occurrences. Default: false (only first match)."
                                    }
                                },
                                "required": ["search", "replace"]
                            }
                        }
                    },
                    "required": ["path", "patches"]
                }),
            },
        },
        // 11b. apply_edit (precision editing with diff preview)
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "apply_edit".to_string(),
                description: "Edit a note using old_string/new_string pairs with fuzzy matching. Returns a diff preview. Use this for precise edits that preserve context. If the exact text isn't found, it tries matching ignoring whitespace differences.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to edit"
                        },
                        "edits": {
                            "type": "array",
                            "description": "List of edits to apply in order",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "old_string": {
                                        "type": "string",
                                        "description": "The exact text to find (will try fuzzy match if exact fails)"
                                    },
                                    "new_string": {
                                        "type": "string",
                                        "description": "The replacement text"
                                    },
                                    "expected_replacements": {
                                        "type": "integer",
                                        "description": "Expected number of matches (default 1). Warns if count differs."
                                    }
                                },
                                "required": ["old_string", "new_string"]
                            }
                        }
                    },
                    "required": ["path", "edits"]
                }),
            },
        },
        // 12. rename_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "rename_note".to_string(),
                description: "Rename a note file in the vault. The file extension is preserved automatically. Use this to add prefixes, change titles, or reorganize files.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "old_path": {
                            "type": "string",
                            "description": "Current file path of the note (relative or absolute)"
                        },
                        "new_path": {
                            "type": "string",
                            "description": "New file path for the note (relative or absolute)"
                        }
                    },
                    "required": ["old_path", "new_path"]
                }),
            },
        },
        // 13. delete_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "delete_note".to_string(),
                description: "Delete a note file from the vault. DESTRUCTIVE: requires user approval. Use with caution.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to delete"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        // 14. get_backlinks
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_backlinks".to_string(),
                description: "Get all notes that contain a [[wikilink]] pointing to a specific note, plus AI-discovered semantic relations. Returns: count, and for each backlink: source path, title, relation type. Use for 'who references this note' questions. Different from get_local_graph which shows bidirectional structural connections.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to find backlinks for"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        // 15. get_note_tags
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_note_tags".to_string(),
                description: "Query note tags and metadata. Without arguments, returns all unique tags in the vault with counts. With a 'tag' argument, returns all notes that have that specific tag. Use to explore knowledge categories.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "tag": {
                            "type": "string",
                            "description": "Optional: filter to a specific tag to find all notes with that tag"
                        }
                    }
                }),
            },
        },
        // 16. append_to_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "append_to_note".to_string(),
                description: "Append content to the end of an existing note without overwriting. Adds a blank line separator before the new content. Use this instead of edit_note when you just want to add to a note.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note to append to"
                        },
                        "content": {
                            "type": "string",
                            "description": "The markdown content to append"
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        // 17. get_vault_stats
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_vault_stats".to_string(),
                description: "Get quantitative statistics about the knowledge vault. Returns: total_notes, total_connections, total_chunks, orphan_count, hub_count, tag_distribution (tag→count), and recent_activity. Use alongside get_graph for a comprehensive vault health overview.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // 18. web_search (was 16)
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "web_search".to_string(),
                description: "Search the internet using DuckDuckGo. Use this when the user's question goes beyond what's in the local knowledge base, or when you need to find up-to-date information, definitions, or external references. Returns titles, URLs, and snippets.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query (use natural language, e.g. 'Rust Pin Unpin explained')"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results to return (default 5, max 10)",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }),
            },
        },
        // 19. fetch_web_content
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "fetch_web_content".to_string(),
                description: "Fetch a web page and convert it to clean Markdown. Strips ads, navigation, scripts, and other noise. Use this when the user provides a URL and wants to read, summarize, or save the content. Optionally saves the result as a note in the vault.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The full URL of the web page to fetch (e.g. 'https://en.wikipedia.org/wiki/Zettelkasten')"
                        },
                        "save_to_vault": {
                            "type": "boolean",
                            "description": "If true, saves the fetched content as a Markdown note in the vault under _web_clips/ folder. Default false.",
                            "default": false
                        }
                    },
                    "required": ["url"]
                }),
            },
        },
        // 20. find_similar_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "find_similar_notes".to_string(),
                description: "Find notes with similar content to a given note, ranked by semantic (meaning-based) similarity using the built-in embedding engine. Returns top-N results with similarity scores.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": {
                            "type": "string",
                            "description": "Path to the note to find similar notes for"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of similar notes to return (default 5)",
                            "default": 5
                        }
                    },
                    "required": ["note_path"]
                }),
            },
        },
        // 21. move_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "move_note".to_string(),
                description: "Move a note to a different directory within the vault. Updates all database records and wikilinks in other notes automatically.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Current path of the note to move"
                        },
                        "destination": {
                            "type": "string",
                            "description": "Target directory path (relative to vault root)"
                        }
                    },
                    "required": ["path", "destination"]
                }),
            },
        },
        // 22. merge_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "merge_notes".to_string(),
                description: "Merge two notes into one. Appends the content of the source note to the target note, then deletes the source. All wikilinks pointing to the source are updated to point to the target.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "source_path": {
                            "type": "string",
                            "description": "Path of the note to merge FROM (will be deleted)"
                        },
                        "target_path": {
                            "type": "string",
                            "description": "Path of the note to merge INTO (will receive content)"
                        }
                    },
                    "required": ["source_path", "target_path"]
                }),
            },
        },
        // 23. read_memory
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "read_memory".to_string(),
                description: "Read the agent's structured persistent memory (Core Memory). Returns categorized sections: User Preferences, Workflow Habits, Important Decisions, Vault Context, Research Topics. Always read before updating to avoid overwriting.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // 24. update_memory
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "update_memory".to_string(),
                description: "Update the agent's persistent Core Memory. Supports incremental section-based updates (preferred) or full replacement. Use sections to categorize: preferences, habits, decisions, vault, research. Always read_memory first to see current state.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The memory content to add/remove/replace. Use concise bullet points."
                        },
                        "section": {
                            "type": "string",
                            "description": "Target section: 'preferences', 'habits', 'decisions', 'vault', or 'research'. If omitted, replaces all content (legacy mode).",
                            "enum": ["preferences", "habits", "decisions", "vault", "research"]
                        },
                        "action": {
                            "type": "string",
                            "description": "How to update: 'add' (append, default), 'remove' (delete matching items), 'replace_section' (overwrite section).",
                            "enum": ["add", "remove", "replace_section"],
                            "default": "add"
                        }
                    },
                    "required": ["content"]
                }),
            },
        },
        // 25. batch_read_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "batch_read_notes".to_string(),
                description: "Read multiple notes at once. Returns each note's path, title, and content (truncated to max_chars_per_note). Use instead of calling read_note multiple times. Maximum 5 notes per call.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Array of file paths to read (max 5)"
                        },
                        "max_chars_per_note": {
                            "type": "integer",
                            "description": "Maximum characters per note (default 2000). Use smaller values when reading many notes.",
                            "default": 2000
                        }
                    },
                    "required": ["paths"]
                }),
            },
        },
        // 26. search_by_tag
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "search_by_tag".to_string(),
                description: "Find all notes that have a specific AI-generated tag. Returns note paths, titles, types, and all tags. Tags are lowercase hyphenated (e.g. 'reinforcement-learning', 'project-deadline').".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "tag": {
                            "type": "string",
                            "description": "The tag to search for (case-insensitive, partial match supported)"
                        }
                    },
                    "required": ["tag"]
                }),
            },
        },
        // 27. get_note_metadata
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_note_metadata".to_string(),
                description: "Get the AI-generated metadata for a note WITHOUT reading its full content. Returns: note_type, tags, suggested_links, contradictions, extracted_facts, and chunk_count. Much faster and lighter than read_note when you only need the analysis.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path of the note"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        // 28. query_relations
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "query_relations".to_string(),
                description: "Query note-to-note relationships by type. Returns pairs of notes with their relationship. Types: 'supports', 'contradicts', 'refines', 'supplementary', 'exemplifies', 'depends_on', 'supersedes', 'wikilink'. Omit relation_type to get all relations. Use to find contradictions, discover support chains, trace knowledge dependencies, or identify superseded notes.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "relation_type": {
                            "type": "string",
                            "description": "Filter by relation type: supports|contradicts|refines|supplementary|exemplifies|depends_on|supersedes|wikilink. Omit for all."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum results to return (default 50)",
                            "default": 50
                        }
                    }
                }),
            },
        },
        // 29. read_canvas
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "read_canvas".to_string(),
                description: "Read the full structure of an Obsidian-compatible whiteboard canvas (.canvas) file, returning descriptions of all notes/cards, sticky notes, and connecting lines.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "canvas_path": {
                            "type": "string",
                            "description": "The file path to the .canvas file in the vault (e.g., 'whiteboard.canvas')"
                        }
                    },
                    "required": ["canvas_path"]
                }),
            },
        },
        // 30. modify_canvas
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "modify_canvas".to_string(),
                description: "Modify an Obsidian-compatible whiteboard canvas (.canvas) file by applying a sequence of operations: adding note cards/sticky notes, updating content/positions, drawing arrows, or removing elements. If the canvas file does not exist, it will be initialized as a new canvas.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "canvas_path": {
                            "type": "string",
                            "description": "The file path to the .canvas file to modify (e.g., 'whiteboard.canvas')"
                        },
                        "operations": {
                            "type": "array",
                            "description": "A list of operations to apply. Each operation must have an 'op' field ('add_node', 'remove_node', 'update_node', 'add_edge', 'remove_edge').",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "op": {
                                        "type": "string",
                                        "enum": ["add_node", "remove_node", "update_node", "add_edge", "remove_edge"]
                                    },
                                    "type": {
                                        "type": "string",
                                        "enum": ["file", "text", "group"],
                                        "description": "Only used for add_node: 'file' for notes, 'text' for sticky notes, 'group' for frame"
                                    },
                                    "id": {
                                        "type": "string",
                                        "description": "Element ID. For remove/update/add_edge, this is required. For add_node, if omitted, a new unique ID will be auto-generated."
                                    },
                                    "x": { "type": "integer" },
                                    "y": { "type": "integer" },
                                    "width": { "type": "integer" },
                                    "height": { "type": "integer" },
                                    "file": {
                                        "type": "string",
                                        "description": "Path to the markdown file relative to vault (used only for file nodes)"
                                    },
                                    "text": {
                                        "type": "string",
                                        "description": "Text content for sticky notes (used only for text nodes)"
                                    },
                                    "label": {
                                        "type": "string",
                                        "description": "Label for group frames or arrows"
                                    },
                                    "color": {
                                        "type": "string",
                                        "description": "Optional hex color code or Obsidian canvas color index"
                                    },
                                    "from": {
                                        "type": "string",
                                        "description": "Source node ID (used only for add_edge)"
                                    },
                                    "to": {
                                        "type": "string",
                                        "description": "Target node ID (used only for add_edge)"
                                    },
                                    "fromSide": {
                                        "type": "string",
                                        "enum": ["top", "right", "bottom", "left"],
                                        "description": "Optional side of source node to connect from (default 'right')"
                                    },
                                    "toSide": {
                                        "type": "string",
                                        "enum": ["top", "right", "bottom", "left"],
                                        "description": "Optional side of target node to connect to (default 'left')"
                                    }
                                },
                                "required": ["op"]
                            }
                        }
                    },
                    "required": ["canvas_path", "operations"]
                }),
            },
        },
        // 31. list_workspace_folders (extended: optional workspace param to list subfolders)
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "list_workspace_folders".to_string(),
                description: "List workspace directories. Without parameters, returns all mounted vault root directories. With the 'workspace' parameter, returns all subfolders within that specific workspace.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Optional. Workspace index (e.g. '0', '1') or absolute path. If omitted, lists all vault root directories. If provided, lists all subfolders within that workspace."
                        }
                    },
                    "required": []
                }),
            },
        },
        // 32. create_folder
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "create_folder".to_string(),
                description: "Create a new folder inside a workspace vault. The folder path is relative to the workspace root. Parent directories are created automatically if they don't exist. SENSITIVE: requires user approval.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The folder path to create, relative to the workspace root. e.g. 'Projects/AI' will create 'Projects/AI/' inside the vault."
                        },
                        "workspace": {
                            "type": "string",
                            "description": "Optional. Workspace index (e.g. '0', '1') or absolute path. Defaults to the primary workspace (index 0). Use list_workspace_folders to discover available workspaces."
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        // ── New Tools: Knowledge Graph Write ────────────────────────
        // 33. add_relation
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "add_relation".to_string(),
                description: "Create a semantic relation between two notes in the knowledge graph. Relation types: supports, contradicts, related, references, extends, example_of.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "source_path": { "type": "string", "description": "File path of the source note" },
                        "target_path": { "type": "string", "description": "File path of the target note" },
                        "relation_type": { "type": "string", "description": "Type of relation: supports, contradicts, related, references, extends, example_of" },
                        "reason": { "type": "string", "description": "Optional reason/explanation for this relation" }
                    },
                    "required": ["source_path", "target_path", "relation_type"]
                }),
            },
        },
        // 34. delete_relation
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "delete_relation".to_string(),
                description: "Remove a relation between two notes in the knowledge graph.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "source_path": { "type": "string", "description": "File path of the source note" },
                        "target_path": { "type": "string", "description": "File path of the target note" }
                    },
                    "required": ["source_path", "target_path"]
                }),
            },
        },
        // 35. get_relations_by_type
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_relations_by_type".to_string(),
                description: "Get all edges in the knowledge graph filtered by relation type (e.g. all 'contradicts' relations).".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "relation_type": { "type": "string", "description": "Filter by this relation type: supports, contradicts, related, references, wikilink, semantic" }
                    },
                    "required": ["relation_type"]
                }),
            },
        },
        // ── New Tools: Database Query ───────────────────────────────
        // 36. query_database
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "query_database".to_string(),
                description: "Query the structured database of all notes with filtering by note_type, tag, folder, and sorting. Returns rich metadata (type, tags, link count, confidence, last_synced). More powerful than list_notes for structured queries.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_type": { "type": "string", "description": "Filter by note type: permanent, fleeting, literature, hub, index, journal" },
                        "tag": { "type": "string", "description": "Filter by tag (case-insensitive match)" },
                        "folder": { "type": "string", "description": "Filter by folder path prefix" },
                        "sort_by": { "type": "string", "enum": ["path", "date", "size"], "description": "Sort order (default: path)" },
                        "limit": { "type": "integer", "description": "Max results (default 50, max 200)" }
                    }
                }),
            },
        },
        // ── New Tools: Canvas ───────────────────────────────────────
        // 37. create_canvas
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "create_canvas".to_string(),
                description: "Create a new empty canvas (whiteboard) file. Use modify_canvas to add nodes and edges afterwards.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "canvas_path": { "type": "string", "description": "Path for the new canvas file (relative to vault root, e.g. 'boards/my-board.canvas')" },
                        "title": { "type": "string", "description": "Optional title text node to add to the canvas" }
                    },
                    "required": ["canvas_path"]
                }),
            },
        },
        // ── New Tools: File System ──────────────────────────────────
        // 38. delete_folder
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "delete_folder".to_string(),
                description: "Delete an empty folder from the vault. Only works on empty directories for safety.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Folder path to delete (relative to vault root)" }
                    },
                    "required": ["path"]
                }),
            },
        },
        // 39. get_directory_tree
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_directory_tree".to_string(),
                description: "Get the full recursive directory tree of the vault or a subfolder. Returns all files and folders with sizes.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Root path (relative to vault, empty = vault root)" },
                        "max_depth": { "type": "integer", "description": "Maximum depth to traverse (default 5)" }
                    }
                }),
            },
        },
        // ── New Tools: Wikilink Management ──────────────────────────
        // 40. resolve_wikilink
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "resolve_wikilink".to_string(),
                description: "Resolve a [[wikilink title]] to its actual file path in the vault. Returns the matched file path or null if not found.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "The wikilink title to resolve (e.g. 'BERT' for [[BERT]])" }
                    },
                    "required": ["title"]
                }),
            },
        },
        // 41. fix_broken_link
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "fix_broken_link".to_string(),
                description: "Fix a broken wikilink in a note file. Can remove the link or replace it with a new target.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "file_path": { "type": "string", "description": "Path to the file containing the broken link" },
                        "target_title": { "type": "string", "description": "The broken link title (e.g. 'Old Note Name')" },
                        "line_number": { "type": "integer", "description": "Line number where the broken link appears" },
                        "action": { "type": "string", "enum": ["remove", "replace"], "description": "Action: 'remove' to delete the link, 'replace' to change the target" },
                        "replacement": { "type": "string", "description": "New link target (required when action='replace')" }
                    },
                    "required": ["file_path", "target_title", "line_number", "action"]
                }),
            },
        },
        // ── New Tools: Index & Sync ─────────────────────────────────
        // 42. get_embedding_status
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_embedding_status".to_string(),
                description: "Check the embedding index status: total chunks, indexed chunks, coverage percentage, and whether vector search is available.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // 43. trigger_sync
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "trigger_sync".to_string(),
                description: "Trigger a vault sync: scan for new, modified, and deleted markdown files, update the database. Use after adding new notes outside the app.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // 44. rebuild_semantic_edges
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "rebuild_semantic_edges".to_string(),
                description: "Rebuild all semantic edges in the knowledge graph based on vector similarity. Recalculates note-to-note relationships from embeddings. Use after embedding new notes.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
        // ── New Tools: Timeline & Facts ─────────────────────────────
        // 45. get_note_facts
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_note_facts".to_string(),
                description: "Get AI-extracted key facts from a specific note. Each fact includes content, confidence score, source, and extraction timestamp.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": { "type": "string", "description": "Path to the note" },
                        "include_history": { "type": "boolean", "description": "If true, include superseded/old facts (default false)" }
                    },
                    "required": ["note_path"]
                }),
            },
        },
        // 46. get_global_timeline
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_global_timeline".to_string(),
                description: "Get a timeline of events across the entire vault within a date range. Events include note creation, modification, fact extraction, etc.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "start_date": { "type": "string", "description": "Start date (YYYY-MM-DD format, default: all time)" },
                        "end_date": { "type": "string", "description": "End date (YYYY-MM-DD format, default: now)" }
                    }
                }),
            },
        },
        // 47. generate_structure_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "generate_structure_note".to_string(),
                description: "Search the knowledge base for notes related to a topic and generate a structured Map of Content (MOC) note containing wikilinks and conceptual groups. Returns markdown content of the generated structure note.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "The topic or theme for the structure note (e.g. 'Machine Learning')"
                        },
                        "depth": {
                            "type": "string",
                            "enum": ["shallow", "deep"],
                            "description": "How deep the search and synthesis should go. 'shallow' (default) searches top 10 notes, 'deep' searches top 20 notes.",
                            "default": "shallow"
                        }
                    },
                    "required": ["topic"]
                }),
            },
        },
        // 48. explain_relationship
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "explain_relationship".to_string(),
                description: "Read the content of two notes, look up their existing relations and common context in the database, and explain their semantic connection. Returns a JSON object detailing relation type, semantic explanation, connection strength, and shared concepts.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_a": {
                            "type": "string",
                            "description": "File path of the first note (e.g. 'ideas/artificial-intelligence.md')"
                        },
                        "note_b": {
                            "type": "string",
                            "description": "File path of the second note (e.g. 'concepts/neural-networks.md')"
                        }
                    },
                    "required": ["note_a", "note_b"]
                }),
            },
        },
        // 49. extract_facts
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "extract_facts".to_string(),
                description: "Extract key factual claims from a note using LLM analysis and store them in the temporal fact engine. Each fact includes a confidence score and category (definition, claim, result, opinion, observation). Use when the user wants to capture what a note 'knows' or track how facts change over time.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": { "type": "string", "description": "File path of the note to extract facts from" },
                        "force_re_extract": { "type": "boolean", "description": "If true, re-extract facts even if already extracted (default false)" }
                    },
                    "required": ["note_path"]
                }),
            },
        },
        // 50. query_temporal
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "query_temporal".to_string(),
                description: "Query the temporal fact engine. Can query facts for a specific note, search facts across all notes by keyword, or get recent facts vault-wide. Use 'before_date' (YYYY-MM-DD) to see what was known at a point in time. Use for: 'what did I believe about X last year?', 'show me all facts about Python', 'track how my understanding has changed'.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": { "type": "string", "description": "Get facts for a specific note" },
                        "fact_query": { "type": "string", "description": "Free-text search across all facts (LIKE match)" },
                        "before_date": { "type": "string", "description": "YYYY-MM-DD — only show facts from before this date for time-travel queries" },
                        "limit": { "type": "integer", "description": "Maximum results (default 30)", "default": 30 }
                    }
                }),
            },
        },
        // 51. batch_link_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "batch_link_notes".to_string(),
                description: "Create multiple note-to-note relations at once. Each link specifies source_path, target_path, relation_type, and optional reason. Relation types: supports, contradicts, refines, supplementary, exemplifies, depends_on, supersedes, related. Use to bridge knowledge gaps identified by run_lint. Much more efficient than calling add_relation repeatedly.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "links": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "source_path": { "type": "string" },
                                    "target_path": { "type": "string" },
                                    "relation_type": { "type": "string" },
                                    "reason": { "type": "string" }
                                },
                                "required": ["source_path", "target_path", "relation_type"]
                            }
                        }
                    },
                    "required": ["links"]
                }),
            },
        },
        // 52. compare_notes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "compare_notes".to_string(),
                description: "Deeply compare two notes using LLM analysis. Returns similarities, differences, contradictions, merge potential, and a suggested relationship. Use when the user asks 'how are these two notes related?' or 'should I merge these?' or 'what are the conflicts between note A and B?'".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_a": { "type": "string", "description": "File path of the first note" },
                        "note_b": { "type": "string", "description": "File path of the second note" }
                    },
                    "required": ["note_a", "note_b"]
                }),
            },
        },
        // 53. ocr_image
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "ocr_image".to_string(),
                description: "Extract text from an image using OCR (tries vision LLM first, falls back to local ppocr model). Can optionally store the extracted text as a new note in _ocr_results/. Perfect for digitizing whiteboard photos, screenshots, and scanned documents. Use when the user uploads or references an image file and wants its text content extracted.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "image_path": { "type": "string", "description": "File path of the image to OCR (supports jpg, png, webp, bmp)" },
                        "store_as_note": { "type": "boolean", "description": "If true, store the extracted text as a new markdown note (default false)" },
                        "note_title": { "type": "string", "description": "Title for the note if store_as_note is true (default 'OCR Result')" }
                    },
                    "required": ["image_path"]
                }),
            },
        },
        // 54. group_canvas_nodes
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "group_canvas_nodes".to_string(),
                description: "Group a list of canvas nodes under a group frame with a label. Automatically calculates bounding box coordinates. SENSITIVE: requires user approval.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "canvas_path": { "type": "string", "description": "The file path of the .canvas file relative to vault" },
                        "node_ids": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "IDs of nodes to group"
                        },
                        "group_name": { "type": "string", "description": "Label title for the group frame" }
                    },
                    "required": ["canvas_path", "node_ids", "group_name"]
                }),
            },
        },
        // 55. arrange_canvas_by
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "arrange_canvas_by".to_string(),
                description: "Automatically arrange/layout note cards in a canvas file using a specified layout strategy (methodology, cluster, timeline). SENSITIVE: requires user approval.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "canvas_path": { "type": "string", "description": "The file path of the .canvas file relative to vault" },
                        "strategy": {
                            "type": "string",
                            "enum": ["methodology", "cluster", "timeline"],
                            "description": "Layout strategy: 'methodology' (Zettelkasten column layout), 'cluster' (algorithmic force-directed cluster layout), 'timeline' (chronological horizontal layout)"
                        }
                    },
                    "required": ["canvas_path", "strategy"]
                }),
            },
        },
        // 56. propagate_fact_update
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "propagate_fact_update".to_string(),
                description: "Propagate an updated fact (by ID) to all dependent downstream notes (detected via depends_on relationships). Generates search-replace patches using LLM to update downstream contents. SENSITIVE: requires user approval.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "fact_id": { "type": "integer", "description": "The ID of the old fact in fact_history table that has changed" },
                        "new_content": { "type": "string", "description": "The updated factual text content" }
                    },
                    "required": ["fact_id", "new_content"]
                }),
            },
        },
        // 59. extract_pdf_text
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "extract_pdf_text".to_string(),
                description: "Extract text content from a PDF file in the vault. Returns page-by-page text with page numbers. Pages with little extractable text (scanned images) are flagged for OCR. Optionally save the extracted text as a Markdown note.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pdf_path": {
                            "type": "string",
                            "description": "Path to the PDF file (relative to vault or absolute)"
                        },
                        "max_pages": {
                            "type": "integer",
                            "description": "Maximum number of pages to extract (default 50)",
                            "default": 50
                        },
                        "save_to_vault": {
                            "type": "boolean",
                            "description": "If true, save the extracted text as a Markdown note in _pdf_extracts/ folder (default false)",
                            "default": false
                        }
                    },
                    "required": ["pdf_path"]
                }),
            },
        },
        // 60. get_note_history
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "get_note_history".to_string(),
                description: "Get the complete modification history of a note, including AI reconciliation actions, timeline events, and fact changes. Returns a merged, time-sorted list of all recorded changes.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": {
                            "type": "string",
                            "description": "Path to the note file (relative to vault or absolute)"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of history entries to return (default 20)",
                            "default": 20
                        }
                    },
                    "required": ["note_path"]
                }),
            },
        },
        // 61. revert_note
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "revert_note".to_string(),
                description: "Revert a note to a previous version by providing the exact content to restore. The current content is backed up in the history log before overwriting. SENSITIVE: requires user approval.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note_path": {
                            "type": "string",
                            "description": "Path to the note file to revert (relative to vault or absolute)"
                        },
                        "content": {
                            "type": "string",
                            "description": "The exact text content to revert the note to. Use get_note_history to review past changes before reverting."
                        }
                    },
                    "required": ["note_path", "content"]
                }),
            },
        },
        // 58. todo_write — model-driven planning tool (Cursor/Claude Code style).
        // Handled inline by the agent loop (emit PlanUpdate to frontend), NOT by try_execute.
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "todo_write".to_string(),
                description: "Create or update the live task plan shown to the user. Call this BEFORE starting non-trivial multi-step work, and again whenever a step's status changes. Each step has a short human-readable text (one concrete action) and a status: 'pending', 'in_progress', or 'done'. Do NOT add (tool) annotations to step text — step text is for human-readable descriptions only; the parser no longer extracts tool names from step text. IMPORTANT: this tool only updates the UI checklist — it does NOT execute any tool. After marking a step in_progress, call the tool for that step in your next response. Never call todo_write twice without a real tool in between. For simple greetings or single-shot questions, do NOT call this tool.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "description": "The full current plan. Sending the full list each time replaces the previous plan.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "text": { "type": "string", "description": "Short description of the step (one concrete action)" },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "done"],
                                        "description": "Current status of this step"
                                    }
                                },
                                "required": ["text", "status"]
                            }
                        }
                    },
                    "required": ["steps"]
                }),
            },
        },
    ]
}


/// Try to execute an internal tool. Returns None if tool is unknown.
pub async fn try_execute(
    name: &str,
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
    llm_config: &crate::llm::LlmConfig,
) -> Option<anyhow::Result<String>> {
    let result = match name {
        // Search operations
        "search_notes" => Some(search_ops::execute_search_notes(arguments, db)),
        "list_notes" => Some(search_ops::execute_list_notes(arguments, db)),
        "find_similar_notes" => Some(search_ops::execute_find_similar_notes(arguments, db)),
        "search_by_tag" => Some(search_ops::execute_search_by_tag(arguments, db)),

        // Note operations
        "read_note" => Some(note_ops::execute_read_note(arguments, vault_path, all_vault_paths)),
        "create_note" => Some(note_ops::execute_create_note(arguments, vault_path, all_vault_paths)),
        "edit_note" => Some(note_ops::execute_edit_note(arguments, vault_path, all_vault_paths)),
        "patch_note" => Some(note_ops::execute_patch_note(arguments, vault_path, all_vault_paths)),
        "apply_edit" => Some(note_ops::execute_apply_edit(arguments, vault_path, all_vault_paths)),
        "rename_note" => Some(note_ops::execute_rename_note(arguments, vault_path, db, all_vault_paths)),
        "delete_note" => Some(note_ops::execute_delete_note(arguments, vault_path, db, all_vault_paths)),
        "append_to_note" => Some(note_ops::execute_append_to_note(arguments, vault_path, all_vault_paths)),
        "move_note" => Some(note_ops::execute_move_note(arguments, vault_path, db, all_vault_paths)),
        "merge_notes" => Some(note_ops::execute_merge_notes(arguments, vault_path, db, all_vault_paths)),
        "batch_read_notes" => Some(note_ops::execute_batch_read_notes(arguments, vault_path, all_vault_paths)),

        // Graph operations
        "get_graph" => Some(graph_ops::execute_get_graph(db)),
        "get_local_graph" => Some(graph_ops::execute_get_local_graph(arguments, db)),
        "find_shortest_path" => Some(graph_ops::execute_find_shortest_path(arguments, db)),
        "get_backlinks" => Some(graph_ops::execute_get_backlinks(arguments, db)),
        "get_note_tags" => Some(graph_ops::execute_get_note_tags(arguments, db)),
        "get_note_metadata" => Some(graph_ops::execute_get_note_metadata(arguments, db)),
        "query_relations" => Some(graph_ops::execute_query_relations(arguments, db)),
        "get_timeline" => Some(graph_ops::execute_get_timeline(arguments, db)),

        // Web operations
        "web_search" => Some(web_ops::execute_web_search(arguments).await),
        "fetch_web_content" => Some(web_ops::execute_fetch_web_content(arguments, vault_path).await),

        // Canvas operations
        "read_canvas" => Some(canvas_ops::execute_read_canvas(arguments, vault_path, all_vault_paths)),
        "modify_canvas" => Some(canvas_ops::execute_modify_canvas(arguments, vault_path, db, all_vault_paths)),

        // Workspace operations
        "list_workspace_folders" => Some(workspace_ops::execute_list_workspace_folders(arguments, all_vault_paths)),
        "create_folder" => Some(workspace_ops::execute_create_folder(arguments, vault_path, all_vault_paths)),
        "get_vault_stats" => Some(workspace_ops::execute_get_vault_stats(db)),
        "run_lint" => Some(workspace_ops::execute_run_lint(db, vault_path)),
        "read_memory" => Some(workspace_ops::execute_read_memory(vault_path)),
        "update_memory" => Some(workspace_ops::execute_update_memory(arguments, vault_path)),

        // ── New Tools ──────────────────────────────────────────────
        // Knowledge Graph Write
        "add_relation" => Some(graph_ops::execute_add_relation(arguments, db)),
        "delete_relation" => Some(graph_ops::execute_delete_relation(arguments, db)),
        "get_relations_by_type" => Some(graph_ops::execute_get_relations_by_type(arguments, db)),

        // Database
        "query_database" => Some(workspace_ops::execute_query_database(arguments, db)),

        // Canvas
        "create_canvas" => Some(canvas_ops::execute_create_canvas(arguments, vault_path, all_vault_paths)),

        // File System
        "delete_folder" => Some(workspace_ops::execute_delete_folder(arguments, vault_path, all_vault_paths)),
        "get_directory_tree" => Some(workspace_ops::execute_get_directory_tree(arguments, vault_path, all_vault_paths)),

        // Wikilink Management
        "resolve_wikilink" => Some(note_ops::execute_resolve_wikilink(arguments, db)),
        "fix_broken_link" => Some(note_ops::execute_fix_broken_link(arguments)),

        // Index & Sync
        "get_embedding_status" => Some(workspace_ops::execute_get_embedding_status(db)),
        "trigger_sync" => Some(workspace_ops::execute_trigger_sync(db, vault_path)),
        "rebuild_semantic_edges" => Some(workspace_ops::execute_rebuild_semantic_edges(db)),

        // Timeline & Facts
        "get_note_facts" => Some(graph_ops::execute_get_note_facts(arguments, db)),
        "get_global_timeline" => Some(graph_ops::execute_get_global_timeline(arguments, db)),

        // Phase: Agent Enhancement
        "generate_structure_note" => Some(note_ops::execute_generate_structure_note(arguments, db, llm_config, vault_path, all_vault_paths).await),
        "explain_relationship" => Some(graph_ops::execute_explain_relationship(arguments, db, llm_config, vault_path, all_vault_paths).await),
        "extract_facts" => Some(graph_ops::execute_extract_facts(arguments, db, llm_config, vault_path, all_vault_paths).await),
        "query_temporal" => Some(graph_ops::execute_query_temporal(arguments, db)),
        "batch_link_notes" => Some(graph_ops::execute_batch_link_notes(arguments, db)),
        "compare_notes" => Some(note_ops::execute_compare_notes(arguments, llm_config, vault_path, all_vault_paths).await),
        "ocr_image" => Some(note_ops::execute_ocr_image(arguments, vault_path, all_vault_paths, Some(llm_config)).await),
        "group_canvas_nodes" => Some(canvas_ops::execute_group_canvas_nodes(arguments, vault_path, all_vault_paths)),
        "arrange_canvas_by" => Some(canvas_ops::execute_arrange_canvas_by(arguments, vault_path, db, all_vault_paths)),
        "propagate_fact_update" => Some(graph_ops::execute_propagate_fact_update(arguments, db, llm_config, vault_path, all_vault_paths).await),

        // PDF & Note History
        "extract_pdf_text" => Some(note_ops::execute_extract_pdf_text(arguments, vault_path, all_vault_paths)),
        "get_note_history" => Some(note_ops::execute_get_note_history(arguments, db, vault_path, all_vault_paths)),
        "revert_note" => Some(note_ops::execute_revert_note(arguments, db, vault_path, all_vault_paths)),

        _ => None,
    };

    // P1-9: Map errors through user_friendly_error for better UX
    result.map(|r| r.map_err(|e| {
        let friendly = helpers::user_friendly_error(&e);
        anyhow::anyhow!("{}", friendly)
    }))
}

pub fn get_internal_tool_summaries() -> Vec<(String, String)> {
    get_internal_tool_defs()
        .into_iter()
        .map(|td| (td.function.name, td.function.description))
        .collect()
}

// ── New Tools (Phase: Agent Enhancement) ───────────────────────────


mod tests {
    #[allow(unused_imports)]
    use super::*;
    #[allow(unused_imports)]
    use std::sync::{Arc, Mutex};
    #[allow(unused_imports)]
    use rusqlite::Connection;
    #[allow(unused_imports)]
    use crate::tools::internal_tools::canvas_ops::{execute_modify_canvas, execute_create_canvas, execute_group_canvas_nodes, execute_arrange_canvas_by};
    
    
    

    #[test]
    fn test_modify_canvas_add_and_remove() {
        let db = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        // Initialize note_relations table
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS note_relations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_path TEXT NOT NULL,
                    target_path TEXT NOT NULL,
                    relation_type TEXT NOT NULL,
                    confidence REAL DEFAULT 0.5,
                    reason TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(source_path, target_path, relation_type)
                );",
                [],
            ).unwrap();
        }

        let temp_canvas = "test_temp_board.canvas";
        // Clean up beforehand if exists
        let _ = std::fs::remove_file(temp_canvas);

        // 1. Add nodes
        let add_nodes_args = serde_json::json!({
            "canvas_path": temp_canvas,
            "operations": [
                {
                    "op": "add_node",
                    "type": "file",
                    "id": "node-file-1",
                    "file": "note1.md",
                    "x": 10,
                    "y": 20
                },
                {
                    "op": "add_node",
                    "type": "text",
                    "id": "node-text-2",
                    "text": "Hello World",
                    "x": 100,
                    "y": 150
                }
            ]
        }).to_string();

        let res = execute_modify_canvas(&add_nodes_args, ".", &db, &[]).unwrap();
        assert!(res.contains("\"success\":true"));
        assert!(res.contains("\"operations_applied\":2"));

        // Verify the file was written
        let content = std::fs::read_to_string(temp_canvas).unwrap();
        let canvas: crate::canvas::Canvas = serde_json::from_str(&content).unwrap();
        assert_eq!(canvas.nodes.len(), 2);

        // 2. Add connection edge
        let add_edge_args = serde_json::json!({
            "canvas_path": temp_canvas,
            "operations": [
                {
                    "op": "add_edge",
                    "from": "node-file-1",
                    "to": "node-text-2",
                    "label": "describes"
                }
            ]
        }).to_string();

        let res = execute_modify_canvas(&add_edge_args, ".", &db, &[]).unwrap();
        assert!(res.contains("\"operations_applied\":1"));

        let content2 = std::fs::read_to_string(temp_canvas).unwrap();
        let canvas2: crate::canvas::Canvas = serde_json::from_str(&content2).unwrap();
        assert_eq!(canvas2.edges.len(), 1);

        // Clean up
        let _ = std::fs::remove_file(temp_canvas);
    }

    #[test]
    fn test_enhancement_tools_routing() {
        crate::db::register_sqlite_vec();
        let db = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        // Initialize database schema in memory db
        {
            let conn = db.lock().unwrap();
            crate::db::schema::setup_database_schema(&conn).unwrap();
        }

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let config = crate::llm::LlmConfig::default();
            // Test that try_execute routes them correctly (even if it returns errors/falls back gracefully because no actual LLM/files are there)
            let args = serde_json::json!({
                "topic": "Machine Learning",
                "depth": "shallow"
            }).to_string();
            
            let res = try_execute("generate_structure_note", &args, &db, ".", &[], &config).await;
            assert!(res.is_some());
            let result_str = res.unwrap().unwrap();
            assert!(result_str.contains("No notes found related to topic"));

            let args_rel = serde_json::json!({
                "note_a": "note1.md",
                "note_b": "note2.md"
            }).to_string();
            let res_rel = try_execute("explain_relationship", &args_rel, &db, ".", &[], &config).await;
            assert!(res_rel.is_some());
            // Since note1.md and note2.md don't exist on FS, it should bail with "Note A does not exist"
            let err = res_rel.unwrap();
            assert!(err.is_err());
            assert!(err.unwrap_err().to_string().contains("Note A does not exist"));
        });
    }

    #[test]
    fn test_canvas_group_and_arrange() {
        crate::db::register_sqlite_vec();
        let db = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        {
            let conn = db.lock().unwrap();
            crate::db::schema::setup_database_schema(&conn).unwrap();
        }

        let current_dir = std::env::current_dir().unwrap();
        let vault_path = current_dir.to_string_lossy().into_owned();
        let all_vaults = vec![vault_path.clone()];

        let temp_canvas = "test_layout_board.canvas";
        let _ = std::fs::remove_file(temp_canvas);

        // 1. Create canvas
        let create_args = serde_json::json!({
            "canvas_path": temp_canvas,
            "title": "Main Board"
        }).to_string();
        let res = execute_create_canvas(&create_args, &vault_path, &all_vaults).unwrap();
        assert!(res.contains("\"success\":true"));

        // 2. Add some nodes via modify_canvas
        let add_args = serde_json::json!({
            "canvas_path": temp_canvas,
            "operations": [
                {
                    "op": "add_node",
                    "type": "file",
                    "id": "node-1",
                    "file": "note1.md",
                    "x": 0,
                    "y": 0
                },
                {
                    "op": "add_node",
                    "type": "file",
                    "id": "node-2",
                    "file": "note2.md",
                    "x": 100,
                    "y": 100
                }
            ]
        }).to_string();
        let res = execute_modify_canvas(&add_args, &vault_path, &db, &all_vaults).unwrap();
        assert!(res.contains("\"success\":true"));

        // 3. Group nodes
        let group_args = serde_json::json!({
            "canvas_path": temp_canvas,
            "node_ids": ["node-1", "node-2"],
            "group_name": "My Group"
        }).to_string();
        let res = execute_group_canvas_nodes(&group_args, &vault_path, &all_vaults).unwrap();
        assert!(res.contains("\"success\":true"));

        // Check file has the group node
        let content = std::fs::read_to_string(temp_canvas).unwrap();
        assert!(content.contains("\"type\": \"group\""));
        assert!(content.contains("My Group"));

        // 4. Arrange canvas by cluster strategy
        let arrange_args = serde_json::json!({
            "canvas_path": temp_canvas,
            "strategy": "cluster"
        }).to_string();
        let res = execute_arrange_canvas_by(&arrange_args, &vault_path, &db, &all_vaults).unwrap();
        assert!(res.contains("\"success\":true"));

        let _ = std::fs::remove_file(temp_canvas);
    }

    #[test]
    fn test_propagate_fact_update_routing() {
        crate::db::register_sqlite_vec();
        let db = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        {
            let conn = db.lock().unwrap();
            crate::db::schema::setup_database_schema(&conn).unwrap();
            // Insert mock file to satisfy FOREIGN KEY constraint on note_path referencing files(path)
            conn.execute(
                "INSERT INTO files (path, hash, title) VALUES ('note1.md', 'mockhash', 'Note 1')",
                []
            ).unwrap();
            // Insert mock fact into fact_history
            conn.execute(
                "INSERT INTO fact_history (note_path, fact_content, created_by) VALUES ('note1.md', 'Model X has O(N) complexity', 'test')",
                []
            ).unwrap();
        }

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let config = crate::llm::LlmConfig::default();
            let args = serde_json::json!({
                "fact_id": 1,
                "new_content": "Model X has O(N^2) complexity"
            }).to_string();

            // Try executing propagate fact update. Since note1.md has no dependents, it should return success with 0 dependents.
            let res = try_execute("propagate_fact_update", &args, &db, ".", &[], &config).await;
            assert!(res.is_some());
            let result_str = res.unwrap().unwrap();
            assert!(result_str.contains("\"success\":true"));
            assert!(result_str.contains("\"dependents_found\":0"));
        });
    }
}

