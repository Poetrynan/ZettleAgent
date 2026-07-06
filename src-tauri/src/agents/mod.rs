// Multi-Agent system: independent agent instances with specialized roles.
// Architecture: AgentInstance → AgentRegistry → AgentRouter → AgentOrchestrator

pub mod instance;
pub mod intent;
pub mod intent_classifier;
pub mod registry;
pub mod router;
pub mod orchestrator;
pub mod strategy;
pub mod fast_path;

/// Tool set constants for each Agent role.
/// Each agent only has access to a subset of the 58 internal tools.

pub const KNOWLEDGE_TOOLS: &[&str] = &[
    "todo_write",
    "search_notes", "list_notes", "read_note", "batch_read_notes",
    "find_similar_notes", "search_by_tag",
    "get_graph", "get_local_graph", "find_shortest_path",
    "get_backlinks", "get_note_tags", "get_note_metadata",
    "query_relations", "get_timeline", "get_vault_stats", "run_lint",
    "web_search", "fetch_web_content",
    "read_memory", "update_memory",
    "read_canvas",
    // New tools
    "add_relation", "get_relations_by_type",     // Graph write (read-heavy agent can also add relations)
    "query_database",                             // Structured database queries
    "get_directory_tree",                         // Browse vault structure
    "resolve_wikilink",                           // Resolve links
    "get_embedding_status",                       // Check index health
    "get_note_facts", "get_global_timeline",      // Timeline & facts
    "generate_structure_note",                    // MOC / structure note generation
    "explain_relationship",                       // LLM-powered relationship explanation
    "extract_facts", "query_temporal", "batch_link_notes", "compare_notes",
    "ocr_image",
];

pub const CREATOR_TOOLS: &[&str] = &[
    "todo_write",
    "search_notes", "list_notes", "read_note", "batch_read_notes",
    "find_similar_notes", "search_by_tag", "get_note_tags",
    "create_note", "edit_note", "patch_note", "append_to_note",
    "create_folder", "read_canvas", "modify_canvas",
    "web_search", "fetch_web_content", "list_workspace_folders",
    "read_memory", "update_memory",
    // New tools
    "query_database",                             // Structured queries for context
    "create_canvas",                              // Create new canvases
    "get_directory_tree",                         // Browse vault structure
    "resolve_wikilink",                           // Resolve links before creating
    "add_relation",                               // Create relations when adding notes
];

pub const CURATOR_TOOLS: &[&str] = &[
    "todo_write",
    "search_notes", "list_notes", "read_note", "batch_read_notes",
    "find_similar_notes",
    "rename_note", "move_note", "merge_notes", "delete_note",
    "edit_note", "append_to_note",
    "create_folder", "list_workspace_folders",
    "run_lint", "get_vault_stats",
    "get_graph", "get_backlinks",
    "get_note_tags", "search_by_tag", "get_note_metadata", "query_relations",
    "read_memory", "update_memory",
    // New tools
    "add_relation", "delete_relation", "get_relations_by_type",  // Full graph write access
    "query_database",                                             // Structured queries
    "delete_folder",                                              // Clean up empty folders
    "get_directory_tree",                                         // Browse vault structure
    "resolve_wikilink", "fix_broken_link",                       // Link maintenance
    "get_embedding_status", "trigger_sync", "rebuild_semantic_edges", // Index management
    "batch_link_notes", "compare_notes",
    "ocr_image",
];
