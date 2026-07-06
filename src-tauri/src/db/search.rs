use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

/// A single search result returned from full-text or vector search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub file_path: String,
    pub chunk_id: i64,
    pub content: String,
    pub heading_hierarchy: Option<String>,
    pub score: f64,
}

/// A node in the knowledge graph.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub note_type: String,
    pub chunk_count: i64,
    pub is_hub: bool,       // most connected nodes
    pub is_orphan: bool,    // no connections
    pub cluster: usize,     // community/cluster id
    pub created_at: String, // earliest chunk timestamp for time travel slider
    pub pagerank: f64,      // KG-3: knowledge importance score
}

/// Cluster info with label and node count.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterInfo {
    pub id: usize,
    pub label: String,
    pub node_count: usize,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SuggestedLink {
    Simple(String),
    Detailed {
        target: String,
        relation: Option<String>,
        reason: Option<String>,
        confidence: Option<f64>,
    }
}

impl SuggestedLink {
    pub fn target(&self) -> &str {
        match self {
            SuggestedLink::Simple(s) => s,
            SuggestedLink::Detailed { target, .. } => target,
        }
    }

    pub fn relation(&self) -> Option<&str> {
        match self {
            SuggestedLink::Simple(_) => None,
            SuggestedLink::Detailed { relation, .. } => relation.as_deref(),
        }
    }

    pub fn confidence(&self) -> f64 {
        match self {
            SuggestedLink::Simple(_) => 0.5,
            SuggestedLink::Detailed { confidence, .. } => confidence.unwrap_or(0.5),
        }
    }
}

/// An edge in the knowledge graph.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub edge_type: String, // "link" | "semantic"
    pub weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// The complete graph data.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub clusters: Vec<ClusterInfo>,
}

/// Perform full-text search using FTS5 on chunk content.
pub fn full_text_search(conn: &Connection, query: &str, limit: usize) -> anyhow::Result<Vec<SearchResult>> {
    // Sanitize query for FTS5: strip special characters that cause syntax errors
    let sanitized: String = query
        .chars()
        .filter(|c| !matches!(c, '*' | '.' | ':' | '(' | ')' | '{' | '}' | '[' | ']' | '^' | '~' | '!' | '\\' | '/' | '&' | '|'))
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        return Ok(vec![]);
    }

    // Split mixed Chinese+English queries into meaningful terms.
    // FTS5 unicode61 tokenizer treats each CJK character as a separate token,
    // so "BERT是什么" would require ALL of (BERT, 是, 什, 么) to match.
    // Instead, we extract English words and CJK character sequences as separate terms
    // and join them with OR for broader matching.
    let fts_query = build_fts_query(&sanitized);

    if fts_query.is_empty() {
        return Ok(vec![]);
    }

    let mut stmt = conn.prepare(
        "SELECT c.id, c.file_path, c.content, c.heading_hierarchy,
                chunks_fts.rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?1
         ORDER BY chunks_fts.rank
         LIMIT ?2",
    )?;

    let results = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            Ok(SearchResult {
                chunk_id: row.get(0)?,
                file_path: row.get(1)?,
                content: row.get(2)?,
                heading_hierarchy: row.get(3)?,
                score: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Build an FTS5 query from mixed Chinese+English input.
/// Extracts English words (kept whole) and Chinese terms (grouped by consecutive CJK chars).
/// Joins them with OR for broader matching.
/// Examples:
///   "BERT是什么" → "BERT OR 是什么"
///   "knowledge graph 知识图谱" → "knowledge OR graph OR 知识图谱"
///   "Transformer" → "Transformer"
fn build_fts_query(input: &str) -> String {
    let mut terms: Vec<String> = Vec::new();
    let mut current_ascii = String::new();
    let mut current_cjk = String::new();

    for c in input.chars() {
        if is_cjk_char(c) {
            // Flush ASCII word if any
            if !current_ascii.is_empty() {
                let word = current_ascii.trim().to_string();
                if !word.is_empty() {
                    terms.push(word);
                }
                current_ascii.clear();
            }
            current_cjk.push(c);
        } else {
            // Flush CJK sequence if any
            if !current_cjk.is_empty() {
                terms.push(current_cjk.clone());
                current_cjk.clear();
            }
            if c.is_whitespace() {
                // Flush ASCII word on space
                let word = current_ascii.trim().to_string();
                if !word.is_empty() {
                    terms.push(word);
                }
                current_ascii.clear();
            } else {
                current_ascii.push(c);
            }
        }
    }

    // Flush remaining
    if !current_ascii.is_empty() {
        let word = current_ascii.trim().to_string();
        if !word.is_empty() {
            terms.push(word);
        }
    }
    if !current_cjk.is_empty() {
        terms.push(current_cjk);
    }

    // Deduplicate
    terms.dedup();

    // Filter out very short CJK stop-word-like terms (single chars like 是, 的, 了, 吗)
    let stop_chars = ['是', '的', '了', '吗', '呢', '吧', '啊', '在', '有', '和', '与', '或', '不', '也', '都', '就', '把', '被', '给', '让', '对', '从', '到', '为', '着', '过', '得', '地', '么'];
    let meaningful_terms: Vec<&String> = terms.iter().filter(|t| {
        // Keep all ASCII terms
        if t.chars().all(|c| !is_cjk_char(c)) {
            return true;
        }
        // For CJK, filter out single stop chars
        if t.chars().count() == 1 && stop_chars.contains(&t.chars().next().unwrap()) {
            return false;
        }
        true
    }).collect();

    if meaningful_terms.is_empty() {
        // Fallback: use all terms
        terms.join(" OR ")
    } else if meaningful_terms.len() == 1 {
        meaningful_terms[0].clone()
    } else {
        meaningful_terms.iter().map(|t| t.as_str()).collect::<Vec<_>>().join(" OR ")
    }
}

/// Check if a character is CJK (Chinese/Japanese/Korean)
fn is_cjk_char(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}' |    // CJK Unified Ideographs
        '\u{3400}'..='\u{4DBF}' |    // CJK Extension A
        '\u{F900}'..='\u{FAFF}' |    // CJK Compatibility Ideographs
        '\u{3000}'..='\u{303F}' |    // CJK Symbols and Punctuation
        '\u{FF00}'..='\u{FFEF}' |    // Fullwidth Forms
        '\u{3040}'..='\u{309F}' |    // Hiragana
        '\u{30A0}'..='\u{30FF}'      // Katakana
    )
}

/// Perform vector similarity search using sqlite-vec.
/// `query_embedding` must be a 768-dimensional f32 vector (nomic-embed-text-v1.5).
pub fn vector_search(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    // Serialize the embedding to bytes (little-endian f32 array)
    let embedding_bytes: Vec<u8> = query_embedding
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();

    let mut stmt = conn.prepare(
        "SELECT c.id, c.file_path, c.content, c.heading_hierarchy,
                vec_distance_cosine(v.embedding, ?1) as distance
         FROM chunks_vec v
         JOIN chunks c ON c.id = v.id
         ORDER BY distance ASC
         LIMIT ?2",
    )?;

    let results = stmt
        .query_map(params![embedding_bytes, limit as i64], |row| {
            Ok(SearchResult {
                chunk_id: row.get(0)?,
                file_path: row.get(1)?,
                content: row.get(2)?,
                heading_hierarchy: row.get(3)?,
                score: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Hybrid search: combine FTS and vector results with reciprocal rank fusion.
pub fn hybrid_search(
    conn: &Connection,
    query: &str,
    query_embedding: &[f32],
    limit: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    // Get results from both search methods (fetch more than needed for fusion)
    let fts_results = full_text_search(conn, query, limit * 2)?;
    let vec_results = vector_search(conn, query_embedding, limit * 2)?;

    // Reciprocal Rank Fusion (RRF)
    let k = 60.0_f64;
    let mut scores: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    let mut chunk_data: std::collections::HashMap<i64, SearchResult> = std::collections::HashMap::new();

    for (rank, result) in fts_results.iter().enumerate() {
        let rrf_score = 1.0 / (k + rank as f64 + 1.0);
        *scores.entry(result.chunk_id).or_insert(0.0) += rrf_score;
        chunk_data.entry(result.chunk_id).or_insert_with(|| SearchResult {
            file_path: result.file_path.clone(),
            chunk_id: result.chunk_id,
            content: result.content.clone(),
            heading_hierarchy: result.heading_hierarchy.clone(),
            score: 0.0,
        });
    }

    for (rank, result) in vec_results.iter().enumerate() {
        let rrf_score = 1.0 / (k + rank as f64 + 1.0);
        *scores.entry(result.chunk_id).or_insert(0.0) += rrf_score;
        chunk_data.entry(result.chunk_id).or_insert_with(|| SearchResult {
            file_path: result.file_path.clone(),
            chunk_id: result.chunk_id,
            content: result.content.clone(),
            heading_hierarchy: result.heading_hierarchy.clone(),
            score: 0.0,
        });
    }

    // Sort by RRF score descending
    let mut combined: Vec<(i64, f64)> = scores.into_iter().collect();
    combined.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<SearchResult> = combined
        .into_iter()
        .take(limit)
        .filter_map(|(chunk_id, score)| {
            chunk_data.get(&chunk_id).map(|d| SearchResult {
                file_path: d.file_path.clone(),
                chunk_id: d.chunk_id,
                content: d.content.clone(),
                heading_hierarchy: d.heading_hierarchy.clone(),
                score,
            })
        })
        .collect();

    Ok(results)
}

/// Fetch knowledge graph data with caching.
/// Returns cached data if available and file count hasn't changed.
/// Otherwise recomputes and caches the result.
pub fn get_graph_data(conn: &Connection) -> anyhow::Result<GraphData> {
    // Check if cache is valid
    let current_file_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
        .unwrap_or(0);

    if let Ok(cached) = get_cached_graph(conn) {
        if cached.nodes.len() as i64 == current_file_count && current_file_count > 0 {
            return Ok(cached);
        }
    }

    // Cache miss or stale: recompute
    let graph = build_graph_data_uncached(conn)?;

    // Store in cache
    if let Ok(serialized) = serde_json::to_vec(&graph) {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO graph_cache (id, serialized_data, node_count, edge_count, computed_at)
             VALUES (1, ?1, ?2, ?3, datetime('now'))",
            params![serialized, graph.nodes.len() as i64, graph.edges.len() as i64],
        );
    }

    Ok(graph)
}

/// Invalidate the graph cache. Call when notes are created, deleted, renamed,
/// or after Smart Organize completes.
pub fn invalidate_graph_cache(conn: &Connection) {
    let _ = conn.execute("DELETE FROM graph_cache WHERE id = 1", []);
}

/// Read cached graph data from the database.
fn get_cached_graph(conn: &Connection) -> anyhow::Result<GraphData> {
    let blob: Vec<u8> = conn.query_row(
        "SELECT serialized_data FROM graph_cache WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    let graph: GraphData = serde_json::from_slice(&blob)?;
    Ok(graph)
}

/// Build graph data from scratch (no caching).
fn build_graph_data_uncached(conn: &Connection) -> anyhow::Result<GraphData> {
    // ── Step 1: Get all files as nodes ──────────────────────────────
    let mut stmt = conn.prepare(
        "SELECT f.path, f.title, COALESCE(cm.note_type, 'permanent'),
                (SELECT COUNT(*) FROM chunks c WHERE c.file_path = f.path),
                (SELECT MIN(c2.created_at) FROM chunks c2 WHERE c2.file_path = f.path)
         FROM files f
         LEFT JOIN card_meta cm ON f.path = cm.file_path",
    )?;

    let mut nodes: Vec<GraphNode> = stmt
        .query_map([], |row| {
            let path: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let note_type: String = row.get(2)?;
            let chunk_count: i64 = row.get(3)?;
            let created_at: Option<String> = row.get(4)?;

            let label = title
                .or_else(|| {
                    path.replace('\\', "/")
                        .rsplit('/')
                        .next()
                        .map(|s| s.replace(".md", ""))
                })
                .unwrap_or_else(|| path.clone());

            Ok(GraphNode {
                id: path,
                label,
                note_type,
                chunk_count,
                is_hub: false,
                is_orphan: false,
                cluster: 0,
                created_at: created_at.unwrap_or_default(),
                pagerank: 0.0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // ── Step 2: Get explicit wikilink edges ─────────────────────────
    let mut stmt = conn.prepare(
        "SELECT file_path, links FROM card_meta WHERE links IS NOT NULL AND links != '[]'",
    )?;

    let mut edges: Vec<GraphEdge> = Vec::new();

    let rows = stmt.query_map([], |row| {
        let file_path: String = row.get(0)?;
        let links_json: String = row.get(1)?;
        Ok((file_path, links_json))
    })?;

    for row in rows {
        let (file_path, links_json) = row?;
        if let Ok(links) = serde_json::from_str::<Vec<SuggestedLink>>(&links_json) {
            for link_item in links {
                let link_target = link_item.target();
                let relation = link_item.relation();
                let link_clean = link_target
                    .trim_start_matches("[[")
                    .trim_end_matches("]]")
                    .trim()
                    .to_lowercase();

                let link_norm = normalize_title(&link_clean);
                if link_norm.is_empty() {
                    continue;
                }

                for node in &nodes {
                    let node_norm = normalize_title(&node.label);
                    let filename = node.id.replace('\\', "/").rsplit('/').next().unwrap_or(&node.id).to_lowercase();
                    let filename_norm = normalize_title(&filename);
                    if node_norm == link_norm || filename_norm == link_norm || filename_norm.contains(&link_norm) {
                        if node.id != file_path {
                            edges.push(GraphEdge {
                                source: file_path.clone(),
                                target: node.id.clone(),
                                edge_type: "link".to_string(),
                                weight: 1.0,
                                label: relation.map(|s| s.to_string()),
                            });
                        }
                        break;
                    }
                }
            }
        }
    }

    // ── Step 2b: Get inline wikilinks from note content chunks ───────
    let mut chunk_stmt = conn.prepare(
        "SELECT file_path, content FROM chunks WHERE content LIKE '%[[%]]%'",
    )?;
    let chunk_rows = chunk_stmt.query_map([], |row| {
        let file_path: String = row.get(0)?;
        let content: String = row.get(1)?;
        Ok((file_path, content))
    })?;

    for row in chunk_rows {
        let (file_path, content) = row?;
        let mut start_idx = 0;
        while let Some(open_idx) = content[start_idx..].find("[[") {
            let actual_open_idx = start_idx + open_idx;
            if let Some(close_idx) = content[actual_open_idx..].find("]]") {
                let actual_close_idx = actual_open_idx + close_idx;
                let link_title = &content[actual_open_idx + 2..actual_close_idx];
                
                let link_clean = link_title.trim().to_lowercase();
                let link_norm = normalize_title(&link_clean);
                
                if !link_norm.is_empty() {
                    for node in &nodes {
                        let node_norm = normalize_title(&node.label);
                        let filename = node.id.replace('\\', "/").rsplit('/').next().unwrap_or(&node.id).to_lowercase();
                        let filename_norm = normalize_title(&filename);
                        if node_norm == link_norm || filename_norm == link_norm || filename_norm.contains(&link_norm) {
                            if node.id != file_path {
                                edges.push(GraphEdge {
                                    source: file_path.clone(),
                                    target: node.id.clone(),
                                    edge_type: "link".to_string(),
                                    weight: 1.0,
                                    label: None,
                                });
                            }
                            break;
                        }
                    }
                }
                
                start_idx = actual_close_idx + 2;
            } else {
                break;
            }
        }
    }

    // ── Step 3: Get precomputed semantic similarity edges ────────────
    // KG-1: Read from semantic_edges table (precomputed by scheduler)
    let semantic_edges = get_precomputed_semantic_edges(conn)?;
    if semantic_edges.is_empty() {
        // No precomputed edges yet: trigger full KNN-based computation
        // (replaces the old O(N²) brute-force fallback for scalability)
        log::info!("No precomputed semantic edges found, computing via KNN...");
        if let Err(e) = compute_and_store_semantic_edges(conn, None) {
            log::warn!("Semantic edge computation failed: {}, skipping semantic edges", e);
        }
        let computed = get_precomputed_semantic_edges(conn)?;
        edges.extend(computed);
    } else {
        edges.extend(semantic_edges);
    }

    // ── Step 3b: Get relation edges from note_relations table ────────
    // These carry labels like "supports", "contradicts", "refines", "supplementary"
    // Filter out very low-confidence relations to reduce graph noise
    let relation_edges = get_all_relation_edges(conn).unwrap_or_default();
    for re in relation_edges {
        // Only add if both source and target exist as nodes
        let src_exists = nodes.iter().any(|n| n.id == re.source);
        let tgt_exists = nodes.iter().any(|n| n.id == re.target);
        if src_exists && tgt_exists {
            edges.push(re);
        }
    }

    // ── Step 3c: Deduplicate edges preserving type diversity ─────────
    // FIX: Previous dedup removed ALL but one edge between any pair, losing
    // valuable information (e.g. a "supports" link AND a semantic similarity
    // edge between the same pair). Now we dedup by (source, target, edge_type, label)
    // to preserve different types of connections.
    edges.sort_by(|a, b| {
        (&a.source, &a.target, &a.edge_type, &a.label)
            .cmp(&(&b.source, &b.target, &b.edge_type, &b.label))
    });
    edges.dedup_by(|a, b| {
        a.source == b.source && a.target == b.target
            && a.edge_type == b.edge_type && a.label == b.label
    });

    // ── Step 3d: Apply edge type weighting ───────────────────────────
    // Different edge types carry different signal strength:
    // - Explicit wikilinks (user-written): strongest signal (weight 1.0)
    // - AI relation edges (LLM-suggested): medium signal (weight = confidence)
    // - Semantic edges (embedding similarity): weaker signal (weight * 0.6)
    // This improves community detection and PageRank accuracy.
    for edge in &mut edges {
        match edge.edge_type.as_str() {
            "link" => {
                // Unlabeled link edges are explicit user wikilinks — strongest
                if edge.label.is_none() {
                    edge.weight = 1.0;
                }
                // Labeled edges (AI relations) keep their confidence-based weight
            }
            "semantic" => {
                // Semantic similarity is a weaker signal than explicit links.
                // Scale down to prevent semantic clusters from overwhelming
                // explicit conceptual connections in community detection.
                edge.weight *= 0.6;
            }
            _ => {}
        }
    }

    // ── Step 4: Detect hub and orphan nodes ─────────────────────────
    let mut connection_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for edge in &edges {
        *connection_count.entry(edge.source.clone()).or_insert(0) += 1;
        *connection_count.entry(edge.target.clone()).or_insert(0) += 1;
    }

    // Hub = top 10% most connected (at least 3 connections)
    let mut counts: Vec<usize> = connection_count.values().copied().collect();
    counts.sort_unstable();
    let hub_threshold = if counts.len() >= 10 {
        counts[counts.len() * 9 / 10].max(3)
    } else {
        3
    };

    for node in &mut nodes {
        let count = connection_count.get(&node.id).copied().unwrap_or(0);
        node.is_hub = count >= hub_threshold;
        node.is_orphan = count == 0;
    }

    // ── Step 5: Community detection using Louvain ────────────────
    let clusters = detect_communities(&mut nodes, &edges);

    // ── Step 6: PageRank for knowledge importance (KG-3) ────────────
    compute_pagerank(&mut nodes, &edges);

    Ok(GraphData { nodes, edges, clusters })
}

/// Cluster colors for visualization.
const CLUSTER_COLORS: &[&str] = &[
    "#10B981", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6",
    "#EC4899", "#06B6D4", "#84CC16", "#F97316", "#6366F1",
    "#14B8A6", "#E11D48", "#A855F7", "#0EA5E9", "#D946EF",
];

/// Detect communities using Louvain modularity optimization.
/// Unlike Union-Find (which only finds connected components), Louvain identifies
/// densely-connected sub-communities within large connected components.
fn detect_communities(nodes: &mut [GraphNode], edges: &[GraphEdge]) -> Vec<ClusterInfo> {
    if nodes.is_empty() {
        return Vec::new();
    }

    // Build node index map
    let mut node_index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        node_index.insert(node.id.clone(), i);
    }

    let n = nodes.len();

    // Build weighted adjacency list
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    let mut total_weight = 0.0_f64;

    for edge in edges {
        if let (Some(&src), Some(&tgt)) = (node_index.get(&edge.source), node_index.get(&edge.target)) {
            if src != tgt {
                let w = edge.weight.max(0.1); // minimum weight
                adj[src].push((tgt, w));
                adj[tgt].push((src, w));
                total_weight += w; // each edge counted once here, but adj is bidirectional
            }
        }
    }

    if total_weight == 0.0 {
        // No edges: each node is its own community
        for (i, node) in nodes.iter_mut().enumerate() {
            node.cluster = i;
        }
        return build_cluster_info(nodes, edges);
    }

    // m = sum of all edge weights (each edge counted once)
    let m = total_weight;

    // Degree (sum of edge weights) for each node
    let mut degree: Vec<f64> = vec![0.0; n];
    for i in 0..n {
        for &(_, w) in &adj[i] {
            degree[i] += w;
        }
    }

    // Initialize: each node in its own community
    let mut community: Vec<usize> = (0..n).collect();

    // Louvain Phase 1: local moving
    // P1-7: Precompute sigma_tot per community ONCE per pass (was O(N²) before)
    let max_passes = 10;
    for _pass in 0..max_passes {
        let mut improved = false;

        // Precompute sigma_tot for all communities at the start of each pass
        let mut sigma_tot: std::collections::HashMap<usize, f64> =
            std::collections::HashMap::new();
        for j in 0..n {
            *sigma_tot.entry(community[j]).or_insert(0.0) += degree[j];
        }

        for i in 0..n {
            let current_comm = community[i];
            let ki = degree[i];

            // Sum of weights to each neighboring community
            let mut comm_weights: std::collections::HashMap<usize, f64> =
                std::collections::HashMap::new();
            for &(j, w) in &adj[i] {
                *comm_weights.entry(community[j]).or_insert(0.0) += w;
            }

            // Weight from node i to its own community
            let ki_in_own = comm_weights.get(&current_comm).copied().unwrap_or(0.0);
            let sigma_own = sigma_tot.get(&current_comm).copied().unwrap_or(0.0);

            // Modularity gain for removing i from current community
            let remove_cost = ki_in_own / m - (sigma_own * ki) / (2.0 * m * m);

            let mut best_comm = current_comm;
            let mut best_gain = 0.0_f64;

            for (&target_comm, &ki_in_target) in &comm_weights {
                if target_comm == current_comm {
                    continue;
                }
                let sigma_target = sigma_tot.get(&target_comm).copied().unwrap_or(0.0);

                // Modularity gain for inserting i into target community
                let insert_gain = ki_in_target / m - (sigma_target * ki) / (2.0 * m * m);
                let delta_q = insert_gain - remove_cost;

                if delta_q > best_gain {
                    best_gain = delta_q;
                    best_comm = target_comm;
                }
            }

            if best_comm != current_comm && best_gain > 1e-10 {
                // Incrementally update sigma_tot when a node moves
                *sigma_tot.entry(current_comm).or_insert(0.0) -= ki;
                *sigma_tot.entry(best_comm).or_insert(0.0) += ki;
                community[i] = best_comm;
                improved = true;
            }
        }

        if !improved {
            break;
        }
    }

    // Renumber communities to be contiguous (0, 1, 2, ...)
    let mut comm_remap: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    let mut next_id = 0;
    for i in 0..n {
        let c = community[i];
        let mapped = *comm_remap.entry(c).or_insert_with(|| {
            let id = next_id;
            next_id += 1;
            id
        });
        nodes[i].cluster = mapped;
    }

    build_cluster_info(nodes, edges)
}

/// Build ClusterInfo from assigned node clusters.
fn build_cluster_info(nodes: &[GraphNode], edges: &[GraphEdge]) -> Vec<ClusterInfo> {
    let mut cluster_nodes: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        cluster_nodes.entry(node.cluster).or_default().push(i);
    }

    let mut clusters: Vec<ClusterInfo> = cluster_nodes
        .iter()
        .map(|(&cid, member_indices)| {
            // Pick the most connected node as the cluster label
            let mut best_label_idx = member_indices[0];
            let mut max_conns = 0usize;
            for &idx in member_indices {
                let node_id = &nodes[idx].id;
                let conns = edges
                    .iter()
                    .filter(|e| e.source == *node_id || e.target == *node_id)
                    .count();
                if conns > max_conns {
                    max_conns = conns;
                    best_label_idx = idx;
                }
            }

            let color_idx = cid % CLUSTER_COLORS.len();
            ClusterInfo {
                id: cid,
                label: nodes[best_label_idx].label.clone(),
                node_count: member_indices.len(),
                color: CLUSTER_COLORS[color_idx].to_string(),
            }
        })
        .collect();

    clusters.sort_by_key(|c| std::cmp::Reverse(c.node_count));
    clusters
}

/// KG-3: Compute PageRank scores for knowledge importance.
/// Identifies "bridge nodes" (connecting different communities) with boosted importance.
/// Weighted PageRank with damping factor d=0.85, 20 iterations.
///
/// Edge weights are respected so that explicit wikilinks (weight=1.0) carry more
/// importance than semantic similarity edges (weight*0.6) or AI-relation edges
/// (weight=confidence) in centrality computation.
fn compute_pagerank(nodes: &mut [GraphNode], edges: &[GraphEdge]) {
    let n = nodes.len();
    if n == 0 {
        return;
    }

    // Build node index map
    let node_index: std::collections::HashMap<&str, usize> = nodes.iter().enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();

    // Build weighted adjacency: out_neighbors[i] = list of (node_index, edge_weight)
    let mut out_neighbors: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];

    for edge in edges {
        if let (Some(&src_idx), Some(&tgt_idx)) = (node_index.get(edge.source.as_str()), node_index.get(edge.target.as_str())) {
            if src_idx != tgt_idx {
                let w = edge.weight.max(0.01); // minimum weight to avoid division issues
                out_neighbors[src_idx].push((tgt_idx, w));
                // Treat undirected: also add reverse
                out_neighbors[tgt_idx].push((src_idx, w));
            }
        }
    }

    // Precompute weighted out-degree for each node
    let mut weighted_out: Vec<f64> = vec![0.0; n];
    for i in 0..n {
        weighted_out[i] = out_neighbors[i].iter().map(|(_, w)| w).sum();
    }

    let d: f64 = 0.85; // damping factor
    let base = (1.0 - d) / n as f64;
    let mut scores: Vec<f64> = vec![1.0 / n as f64; n];
    let mut new_scores: Vec<f64> = vec![0.0; n];

    // 20 iterations of weighted PageRank
    for _ in 0..20 {
        for i in 0..n {
            new_scores[i] = base;
        }

        for i in 0..n {
            if weighted_out[i] > 0.0 {
                // Distribute score proportionally by edge weight
                for &(neighbor, weight) in &out_neighbors[i] {
                    new_scores[neighbor] += d * scores[i] * weight / weighted_out[i];
                }
            } else {
                // Dangling node: distribute evenly
                let contribution = d * scores[i] / n as f64;
                for j in 0..n {
                    new_scores[j] += contribution;
                }
            }
        }

        std::mem::swap(&mut scores, &mut new_scores);
    }

    // Normalize to 0-1 range
    let max_score = scores.iter().cloned().fold(0.0_f64, f64::max);
    let min_score = scores.iter().cloned().fold(f64::MAX, f64::min);
    let range = max_score - min_score;

    for (i, node) in nodes.iter_mut().enumerate() {
        node.pagerank = if range > 0.0 {
            (scores[i] - min_score) / range
        } else {
            0.5
        };
    }

    // Also update is_hub based on PageRank: top 10% by PageRank are hubs
    let mut sorted_scores: Vec<f64> = scores.clone();
    sorted_scores.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let hub_threshold_pr = if sorted_scores.len() >= 10 {
        sorted_scores[sorted_scores.len() * 9 / 10]
    } else {
        sorted_scores.last().copied().unwrap_or(0.0)
    };

    for (i, node) in nodes.iter_mut().enumerate() {
        // Mark as hub if either high connection count OR high PageRank
        if scores[i] >= hub_threshold_pr {
            node.is_hub = true;
        }
    }
}

/// Find semantic similarity edges between files using their chunk embeddings.
/// DEPRECATED: This O(N²) brute-force implementation has been replaced by
/// `compute_and_store_semantic_edges` which uses sqlite-vec KNN for scalability.
/// Kept here for reference; the fallback path now calls compute_and_store_semantic_edges.
#[allow(dead_code)]
fn find_semantic_edges(conn: &Connection, _nodes: &[GraphNode]) -> anyhow::Result<Vec<GraphEdge>> {
    // Get one representative chunk per file (first chunk)
    let mut stmt = conn.prepare(
        "SELECT file_path, embedding FROM chunks
         WHERE embedding IS NOT NULL
         GROUP BY file_path
         HAVING chunk_index = 0",
    )?;

    let mut file_embeddings: Vec<(String, Vec<f32>)> = Vec::new();
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let emb_blob: Vec<u8> = row.get(1)?;
        Ok((path, emb_blob))
    })?;

    for row in rows {
        let (path, blob) = row?;
        let floats: Vec<f32> = blob
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        if !floats.is_empty() {
            file_embeddings.push((path, floats));
        }
    }

    // Compare all pairs and find highly similar ones
    let mut edges = Vec::new();
    let threshold = 0.85_f32; // cosine similarity threshold

    for i in 0..file_embeddings.len() {
        for j in (i + 1)..file_embeddings.len() {
            let (ref path_a, ref emb_a) = file_embeddings[i];
            let (ref path_b, ref emb_b) = file_embeddings[j];

            if emb_a.len() != emb_b.len() || emb_a.is_empty() {
                continue;
            }

            // Cosine similarity
            let dot: f32 = emb_a.iter().zip(emb_b.iter()).map(|(a, b)| a * b).sum();
            let norm_a: f32 = emb_a.iter().map(|x| x * x).sum::<f32>().sqrt();
            let norm_b: f32 = emb_b.iter().map(|x| x * x).sum::<f32>().sqrt();

            if norm_a == 0.0 || norm_b == 0.0 {
                continue;
            }

            let similarity = dot / (norm_a * norm_b);

            if similarity >= threshold {
                edges.push(GraphEdge {
                    source: path_a.clone(),
                    target: path_b.clone(),
                    edge_type: "semantic".to_string(),
                    weight: similarity as f64,
                    label: None,
                });
            }
        }
    }

    Ok(edges)
}

/// Get local graph data for a specific note with configurable depth (1-3 hop, KG-2).
pub fn get_local_graph(conn: &Connection, file_path: &str) -> anyhow::Result<GraphData> {
    get_local_graph_with_depth(conn, file_path, 1)
}

/// Get local graph data with configurable hop depth.
/// depth=1: immediate neighbors, depth=2: neighbors of neighbors, depth=3: 3-hop
pub fn get_local_graph_with_depth(conn: &Connection, file_path: &str, depth: usize) -> anyhow::Result<GraphData> {
    let depth = depth.min(3).max(1); // Clamp to 1-3
    let full_graph = get_graph_data(conn)?;

    // Build adjacency list for efficient traversal
    let mut adjacency: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for edge in &full_graph.edges {
        adjacency.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        adjacency.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
    }

    // BFS to find all nodes within `depth` hops
    let mut connected_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut frontier: Vec<String> = vec![file_path.to_string()];
    connected_ids.insert(file_path.to_string());

    for _hop in 0..depth {
        let mut next_frontier: Vec<String> = Vec::new();
        for node_id in &frontier {
            if let Some(neighbors) = adjacency.get(node_id.as_str()) {
                for &neighbor in neighbors {
                    if connected_ids.insert(neighbor.to_string()) {
                        next_frontier.push(neighbor.to_string());
                    }
                }
            }
        }
        frontier = next_frontier;
    }

    let nodes: Vec<GraphNode> = full_graph
        .nodes
        .into_iter()
        .filter(|n| connected_ids.contains(&n.id))
        .collect();

    let edges: Vec<GraphEdge> = full_graph
        .edges
        .into_iter()
        .filter(|e| connected_ids.contains(&e.source) && connected_ids.contains(&e.target))
        .collect();

    Ok(GraphData { nodes, edges, clusters: Vec::new() })
}

/// Find shortest path between two notes in the knowledge graph (KG-2).
/// Returns the path as a list of note IDs, or empty if no path exists.
pub fn find_shortest_path(conn: &Connection, source: &str, target: &str) -> anyhow::Result<Vec<String>> {
    let full_graph = get_graph_data(conn)?;

    // Build adjacency list
    let mut adjacency: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for edge in &full_graph.edges {
        adjacency.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        adjacency.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
    }

    // BFS from source to target
    let mut visited: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut parent: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let mut queue: std::collections::VecDeque<&str> = std::collections::VecDeque::new();

    visited.insert(source);
    queue.push_back(source);

    let mut found = false;
    while let Some(current) = queue.pop_front() {
        if current == target {
            found = true;
            break;
        }
        if let Some(neighbors) = adjacency.get(current) {
            for &neighbor in neighbors {
                if visited.insert(neighbor) {
                    parent.insert(neighbor, current);
                    queue.push_back(neighbor);
                }
            }
        }
    }

    if !found {
        return Ok(Vec::new()); // No path
    }

    // Reconstruct path
    let mut path = Vec::new();
    let mut current = target;
    while current != source {
        path.push(current.to_string());
        current = match parent.get(current) {
            Some(&p) => p,
            None => break,
        };
    }
    path.push(source.to_string());
    path.reverse();
    Ok(path)
}

/// Helper function to normalize titles/labels for robust matching.
/// Converts to lowercase, strips parenthetical suffix, strips leading numeric prefix,
/// and keeps only alphanumeric and Chinese characters.
pub fn normalize_title(title: &str) -> String {
    let mut clean = title.to_lowercase();
    if let Some(idx) = clean.find('(') {
        clean.truncate(idx);
    }
    if let Some(idx) = clean.find('（') {
        clean.truncate(idx);
    }

    let clean_str = clean.trim();
    let chars: Vec<char> = clean_str.chars().collect();
    let mut start_idx = 0;
    while start_idx < chars.len() && chars[start_idx].is_ascii_digit() {
        start_idx += 1;
    }

    let mut final_start = start_idx;
    if start_idx > 0 && start_idx < chars.len() {
        while final_start < chars.len() && (chars[final_start] == '-' || chars[final_start] == '.' || chars[final_start] == '_' || chars[final_start] == ' ') {
            final_start += 1;
        }
    } else {
        final_start = 0;
    }

    let filtered_chars: Vec<char> = if final_start < chars.len() {
        chars[final_start..].to_vec()
    } else {
        chars.clone()
    };

    filtered_chars
        .into_iter()
        .filter(|c| {
            c.is_alphanumeric() || (*c >= '\u{4e00}' && *c <= '\u{9fa5}')
        })
        .collect()
}

/// Get edges filtered by a specific relation type from note_relations table.
pub fn get_edges_by_relation(conn: &Connection, relation_type: &str) -> anyhow::Result<Vec<GraphEdge>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, target_path, relation_type, confidence, reason
         FROM note_relations WHERE relation_type = ?1",
    )?;

    let edges = stmt
        .query_map(params![relation_type], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                edge_type: "link".to_string(),
                weight: row.get::<_, f64>(3).unwrap_or(0.5),
                label: Some(row.get::<_, String>(2)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(edges)
}

/// Read precomputed semantic edges from the semantic_edges table.
fn get_precomputed_semantic_edges(conn: &Connection) -> anyhow::Result<Vec<GraphEdge>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, target_path, similarity FROM semantic_edges"
    )?;

    let edges = stmt
        .query_map([], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                edge_type: "semantic".to_string(),
                weight: row.get(2)?,
                label: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(edges)
}

/// Precompute semantic similarity edges and persist to the semantic_edges table.
/// Uses file-level mean-pooled embeddings in files_vec for threshold-based edge discovery.
/// `changed_paths`: if Some, only recompute edges involving these paths.
pub fn compute_and_store_semantic_edges(
    conn: &Connection,
    changed_paths: Option<&[String]>,
) -> anyhow::Result<usize> {
    // ── Phase 1: Build/update file-level mean-pooled embeddings ──────
    rebuild_file_embeddings(conn, changed_paths)?;

    // ── Phase 2: Threshold-based semantic edge discovery ─────────────
    // Any file pair with cosine similarity >= threshold gets an edge.
    // No K cap — guaranteed to find ALL edges above threshold.
    let threshold = 0.75_f64;
    let distance_threshold = 1.0 - threshold; // cosine distance = 1 - similarity

    // If changed_paths provided, only delete/recompute edges for those files
    if let Some(paths) = changed_paths {
        for path in paths {
            conn.execute(
                "DELETE FROM semantic_edges WHERE source_path = ?1 OR target_path = ?1",
                params![path],
            )?;
        }
    } else {
        // Full recompute: clear all
        conn.execute("DELETE FROM semantic_edges", [])?;
    }

    // Get the list of files to process
    let file_paths: Vec<String> = if let Some(paths) = changed_paths {
        paths.to_vec()
    } else {
        let mut stmt = conn.prepare("SELECT file_path FROM files_vec")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut edge_count = 0usize;

    // Prepare the neighbor query once (reused per file)
    let mut neighbor_stmt = conn.prepare(
        "SELECT fv.file_path, vec_distance_cosine(fv.embedding, ?1) as distance
         FROM files_vec fv
         WHERE fv.file_path != ?2
           AND distance <= ?3
         ORDER BY distance
         LIMIT 25",
    )?;

    // For each file, find ALL neighbors above similarity threshold
    for file_path in &file_paths {
        // Get this file's embedding
        let file_emb: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM files_vec WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .ok();

        let file_emb = match file_emb {
            Some(emb) => emb,
            None => continue,
        };

        // Find all files within distance threshold (no LIMIT — complete coverage)
        let neighbors: Vec<(String, f64)> = neighbor_stmt
            .query_map(params![file_emb, file_path, distance_threshold], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (neighbor_path, distance) in neighbors {
            let similarity = 1.0 - distance;
            // Use ordered pair to avoid duplicate edges (a,b) and (b,a)
            let (src, tgt) = if *file_path < neighbor_path {
                (file_path.as_str(), neighbor_path.as_str())
            } else {
                (neighbor_path.as_str(), file_path.as_str())
            };

            conn.execute(
                "INSERT OR REPLACE INTO semantic_edges (source_path, target_path, similarity, computed_at)
                 VALUES (?1, ?2, ?3, datetime('now'))",
                params![src, tgt, similarity],
            )?;
            edge_count += 1;
        }
    }

    log::info!(
        "Precomputed {} semantic edges from {} files (threshold={})",
        edge_count, file_paths.len(), threshold
    );
    Ok(edge_count)
}

/// Build/update file-level mean-pooled embeddings in files_vec table.
/// If `changed_paths` is Some, only update those specific files.
fn rebuild_file_embeddings(
    conn: &Connection,
    changed_paths: Option<&[String]>,
) -> anyhow::Result<()> {

    let file_paths_to_process: Vec<String> = if let Some(paths) = changed_paths {
        paths.to_vec()
    } else {
        // Get all file paths with embeddings
        let mut stmt = conn.prepare(
            "SELECT DISTINCT file_path FROM chunks WHERE embedding IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for file_path in &file_paths_to_process {
        // Delete old file embedding
        let _ = conn.execute(
            "DELETE FROM files_vec WHERE file_path = ?1",
            params![file_path],
        );

        // Get all chunk embeddings for this file
        let mut stmt = conn.prepare(
            "SELECT embedding FROM chunks
             WHERE embedding IS NOT NULL AND file_path = ?1
             ORDER BY chunk_index",
        )?;

        let chunk_embeddings: Vec<Vec<f32>> = stmt
            .query_map(params![file_path], |row| {
                let blob: Vec<u8> = row.get(0)?;
                let floats: Vec<f32> = blob
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
                Ok(floats)
            })?
            .filter_map(|r| r.ok())
            .filter(|v| !v.is_empty())
            .collect();

        if chunk_embeddings.is_empty() {
            continue;
        }

        // ── Content quality gate: skip files with trivial content ────────
        // Empty notes, pure-frontmatter templates, and very short stubs
        // produce meaningless embeddings that cause false semantic edges.
        let total_text: String = conn
            .query_row(
                "SELECT COALESCE(GROUP_CONCAT(content, ' '), '') FROM chunks WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .unwrap_or_default();

        if total_text.trim().len() < 50 {
            log::debug!("Skipping file embedding for short content ({}B): {}", total_text.trim().len(), file_path);
            continue;
        }

        // Weighted mean pooling: front chunks (title/intro) get higher weight
        // since they usually contain core content. Exponential decay factor.
        let dim = chunk_embeddings[0].len();
        let total_chunks = chunk_embeddings.len() as f32;
        let mut mean_embedding = vec![0.0_f32; dim];
        let mut weight_sum = 0.0_f32;

        for (idx, emb) in chunk_embeddings.iter().enumerate() {
            if emb.len() != dim {
                continue; // skip mismatched dimensions
            }
            // Exponential decay: first chunk weight ≈ 1.0, last chunk weight ≈ 0.6
            let weight = (-0.5 * idx as f32 / total_chunks).exp();
            for (i, val) in emb.iter().enumerate() {
                mean_embedding[i] += val * weight;
            }
            weight_sum += weight;
        }

        if weight_sum > 0.0 {
            for val in mean_embedding.iter_mut() {
                *val /= weight_sum;
            }
        }

        // L2-normalize the mean embedding for cosine similarity
        let norm: f32 = mean_embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for val in mean_embedding.iter_mut() {
                *val /= norm;
            }
        }

        // Store as bytes in files_vec
        let embedding_bytes: Vec<u8> = mean_embedding
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        let _ = conn.execute(
            "INSERT INTO files_vec (file_path, embedding) VALUES (?1, ?2)",
            params![file_path, embedding_bytes],
        );
    }

    log::info!(
        "Rebuilt file-level embeddings for {} files",
        file_paths_to_process.len()
    );
    Ok(())
}

/// Get all relation edges from note_relations table.
/// Returns edges with relation labels. Used to supplement card_meta.links edges.
/// Filters out very low-confidence relations (confidence < 0.4) to reduce graph noise.
pub fn get_all_relation_edges(conn: &Connection) -> anyhow::Result<Vec<GraphEdge>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, target_path, relation_type, confidence
         FROM note_relations
         WHERE confidence >= 0.4",
    )?;

    let edges = stmt
        .query_map([], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                edge_type: "link".to_string(),
                weight: row.get::<_, f64>(3).unwrap_or(0.5),
                label: Some(row.get::<_, String>(2)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(edges)
}