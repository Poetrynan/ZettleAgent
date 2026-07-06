use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use regex::Regex;
use crate::db::search::normalize_title;

#[derive(Debug, Serialize, Deserialize)]
pub struct LintReport {
    pub orphans: Vec<OrphanInfo>,
    pub broken_links: Vec<BrokenLinkInfo>,
    pub missing_metadata: Vec<MissingMetadataInfo>,
    pub graph_health: GraphHealthInfo,
    pub semantic_duplicates: Vec<SemanticDuplicateInfo>,
    pub hidden_connections: Vec<HiddenConnectionInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrphanInfo {
    pub file_path: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrokenLinkInfo {
    pub file_path: String,
    pub target_title: String,
    pub line_number: usize,
    pub context: String,
    pub suggested_fix: Option<String>, // Closest matching title
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MissingMetadataInfo {
    pub file_path: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphHealthInfo {
    pub connected_components: usize,
    pub largest_component_size: usize,
    pub total_nodes: usize,
    pub total_edges: usize,
    pub hub_overload: Vec<HubOverloadInfo>,
    pub unidirectional_relations: Vec<UnidirectionalInfo>,
    pub missing_embeddings: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HubOverloadInfo {
    pub file_path: String,
    pub title: String,
    pub degree: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnidirectionalInfo {
    pub source: String,
    pub target: String,
    pub relation_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SemanticDuplicateInfo {
    pub file_path_a: String,
    pub title_a: String,
    pub file_path_b: String,
    pub title_b: String,
    pub similarity: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HiddenConnectionInfo {
    pub file_path_a: String,
    pub title_a: String,
    pub file_path_b: String,
    pub title_b: String,
    pub similarity: f64,
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let len_a = a_chars.len();
    let len_b = b_chars.len();

    let mut dp = vec![vec![0; len_b + 1]; len_a + 1];

    for i in 0..=len_a { dp[i][0] = i; }
    for j in 0..=len_b { dp[0][j] = j; }

    for i in 1..=len_a {
        for j in 1..=len_b {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }
    dp[len_a][len_b]
}

/// Simple Union-Find for connected component analysis
struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
            rank: vec![0; n],
        }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    fn union(&mut self, x: usize, y: usize) {
        let rx = self.find(x);
        let ry = self.find(y);
        if rx == ry { return; }
        if self.rank[rx] < self.rank[ry] {
            self.parent[rx] = ry;
        } else if self.rank[rx] > self.rank[ry] {
            self.parent[ry] = rx;
        } else {
            self.parent[ry] = rx;
            self.rank[rx] += 1;
        }
    }
}

/// Run knowledge health check on the whole vault
/// Create a stub note for a broken wikilink target.
/// Returns the full path of the created file.
pub fn create_note_stub(
    conn: &Connection,
    title: &str,
) -> anyhow::Result<String> {
    // Get vault path from database settings
    let vault_path: String = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'vault_path'",
        [],
        |row| row.get(0),
    ).map_err(|_| anyhow::anyhow!("Vault path not configured"))?;

    let file_name = format!("{}.md", title);
    let file_path = std::path::Path::new(&vault_path).join(&file_name);

    if file_path.exists() {
        anyhow::bail!("File already exists: {}", file_path.display());
    }

    // Find all files that reference this title (to add as context)
    let search_pattern = format!("[[{}]]", title);
    let mut referencing: Vec<String> = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT path, title FROM files"
    )?;
    let files: Vec<(String, String)> = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?.filter_map(|r| r.ok()).collect();

    for (fpath, ftitle) in &files {
        if let Ok(content) = std::fs::read_to_string(fpath) {
            if content.contains(&search_pattern) {
                let display_title = if ftitle.is_empty() {
                    fpath.rsplit(['/', '\\']).next().unwrap_or(fpath).replace(".md", "")
                } else {
                    ftitle.clone()
                };
                referencing.push(display_title);
            }
        }
    }

    // Get current date via SQLite (no chrono dependency needed)
    let today: String = conn.query_row(
        "SELECT date('now')",
        [],
        |row| row.get(0),
    ).unwrap_or_else(|_| "2024-01-01".to_string());

    // Build the stub content
    let mut content = format!(
        "---\ntype: permanent\ntags: []\ncreated: {}\n---\n\n# {}\n\n",
        today, title
    );

    // Add referencing context
    if !referencing.is_empty() {
        content.push_str("## Referenced By\n\n");
        for ref_title in &referencing {
            content.push_str(&format!("- [[{}]]\n", ref_title));
        }
        content.push('\n');
    }

    std::fs::write(&file_path, &content)?;

    let created_path = file_path.to_string_lossy().to_string();
    log::info!("Created stub note: {} (referenced by {} notes)", created_path, referencing.len());

    Ok(created_path)
}

pub fn run_vault_lint(conn: &Connection) -> anyhow::Result<LintReport> {
    // 1. Get all nodes and compute orphans using the existing graph logic
    let graph = crate::db::search::get_graph_data(conn)?;
    let orphans: Vec<OrphanInfo> = graph.nodes.iter()
        .filter(|n| n.is_orphan)
        .map(|n| OrphanInfo {
            file_path: n.id.clone(),
            title: n.label.clone(),
        })
        .collect();

    // 2. Fetch all valid files and create normalized titles map
    let mut stmt = conn.prepare("SELECT path, title FROM files")?;
    let files_list: Vec<(String, String)> = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let label = title.unwrap_or_else(|| {
            path.replace('\\', "/")
                .rsplit('/')
                .next()
                .map(|s| s.replace(".md", ""))
                .unwrap_or_else(|| path.clone())
        });
        Ok((path, label))
    })?.collect::<Result<Vec<_>, _>>()?;

    let valid_titles_norm: Vec<(String, String)> = files_list.iter()
        .map(|(_path, title)| (normalize_title(title), title.clone()))
        .collect();

    // 3. Scan each file for broken links and missing metadata
    let mut broken_links = Vec::new();
    let mut missing_metadata = Vec::new();

    let re_wikilink = Regex::new(r"\[\[([^\]]+)\]\]").unwrap();

    for (path_str, title) in &files_list {
        let path = Path::new(path_str);
        if !path.exists() {
            continue;
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Check for missing AI metadata block
        if !content.contains("<!-- @generated -->") {
            missing_metadata.push(MissingMetadataInfo {
                file_path: path_str.clone(),
                title: title.clone(),
            });
        }

        // Scan lines for wikilinks
        for (line_idx, line) in content.lines().enumerate() {
            for cap in re_wikilink.captures_iter(line) {
                let target_title = cap.get(1).unwrap().as_str().trim();
                let target_title_norm = normalize_title(target_title);

                if target_title_norm.is_empty() {
                    continue;
                }

                // Check if target exists in our valid titles list
                let exists = valid_titles_norm.iter().any(|(norm, _)| norm == &target_title_norm);
                if !exists {
                    // Find closest fuzzy match
                    let mut best_match: Option<String> = None;
                    let mut min_dist = usize::MAX;

                    for (norm, actual) in &valid_titles_norm {
                        let dist = levenshtein(&target_title_norm, norm);
                        if dist < min_dist && dist < 5 {
                            min_dist = dist;
                            best_match = Some(actual.clone());
                        }
                    }

                    broken_links.push(BrokenLinkInfo {
                        file_path: path_str.clone(),
                        target_title: target_title.to_string(),
                        line_number: line_idx + 1,
                        context: line.trim().to_string(),
                        suggested_fix: best_match,
                    });
                }
            }
        }
    }

    // 4. Graph health analysis
    let graph_health = compute_graph_health(conn, &graph)?;

    // 5. Semantic analysis — duplicates & hidden connections
    let (semantic_duplicates, hidden_connections) = compute_semantic_analysis(conn, &files_list, &graph)?;

    Ok(LintReport {
        orphans,
        broken_links,
        missing_metadata,
        graph_health,
        semantic_duplicates,
        hidden_connections,
    })
}

/// Compute graph health metrics: connectivity, hub overload, unidirectional relations, embedding coverage
fn compute_graph_health(
    conn: &Connection,
    graph: &crate::db::search::GraphData,
) -> anyhow::Result<GraphHealthInfo> {
    let total_nodes = graph.nodes.len();
    let total_edges = graph.edges.len();

    // 4a. Connected components via Union-Find
    let node_ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    let id_to_idx: std::collections::HashMap<&str, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();

    let mut uf = UnionFind::new(total_nodes);
    for edge in &graph.edges {
        if let (Some(&si), Some(&ti)) = (id_to_idx.get(edge.source.as_str()), id_to_idx.get(edge.target.as_str())) {
            uf.union(si, ti);
        }
    }

    let mut component_sizes: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for i in 0..total_nodes {
        let root = uf.find(i);
        *component_sizes.entry(root).or_insert(0) += 1;
    }
    let connected_components = component_sizes.len();
    let largest_component_size = component_sizes.values().copied().max().unwrap_or(0);

    // 4b. Hub overload detection (degree > 20)
    let mut degree_map: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for edge in &graph.edges {
        *degree_map.entry(edge.source.as_str()).or_insert(0) += 1;
        *degree_map.entry(edge.target.as_str()).or_insert(0) += 1;
    }

    let hub_overload: Vec<HubOverloadInfo> = degree_map.iter()
        .filter(|(_, &deg)| deg > 20)
        .map(|(path, &deg)| {
            let title = graph.nodes.iter()
                .find(|n| n.id == *path)
                .map(|n| n.label.clone())
                .unwrap_or_else(|| path.to_string());
            HubOverloadInfo {
                file_path: path.to_string(),
                title,
                degree: deg,
            }
        })
        .collect();

    // 4c. Unidirectional relation detection (A→B exists but B→A doesn't)
    let mut relation_pairs: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut all_relations: Vec<(String, String, String)> = Vec::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT source_path, target_path, relation_type FROM note_relations"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                relation_pairs.insert((row.0.clone(), row.1.clone()));
                all_relations.push(row);
            }
        }
    }

    let unidirectional_relations: Vec<UnidirectionalInfo> = all_relations.iter()
        .filter(|(src, tgt, _)| !relation_pairs.contains(&(tgt.clone(), src.clone())))
        .take(20)  // Limit output
        .map(|(src, tgt, rel)| UnidirectionalInfo {
            source: src.clone(),
            target: tgt.clone(),
            relation_type: rel.clone(),
        })
        .collect();

    // 4d. Missing embeddings count
    let missing_embeddings: usize = conn.query_row(
        "SELECT COUNT(*) FROM files f WHERE NOT EXISTS (SELECT 1 FROM files_vec fv WHERE fv.file_path = f.path)",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    Ok(GraphHealthInfo {
        connected_components,
        largest_component_size,
        total_nodes,
        total_edges,
        hub_overload,
        unidirectional_relations,
        missing_embeddings,
    })
}

/// Apply a fix to a broken link
pub fn fix_broken_link_in_file(
    file_path: &str,
    target_title: &str,
    line_number: usize,
    action: &str, // "remove_brackets" | "replace"
    replacement: Option<&str>,
) -> anyhow::Result<()> {
    let path = Path::new(file_path);
    let content = fs::read_to_string(path)?;
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();

    if line_number == 0 || line_number > lines.len() {
        anyhow::bail!("Invalid line number: {}", line_number);
    }

    let line = &mut lines[line_number - 1];
    let search_str = format!("[[{}]]", target_title);

    if !line.contains(&search_str) {
        anyhow::bail!("Line does not contain the wikilink: {}", search_str);
    }

    match action {
        "remove_brackets" => {
            *line = line.replace(&search_str, target_title);
        }
        "replace" => {
            if let Some(rep) = replacement {
                let rep_wrapped = if rep.starts_with("[[") { rep.to_string() } else { format!("[[{}]]", rep) };
                *line = line.replace(&search_str, &rep_wrapped);
            } else {
                anyhow::bail!("Replacement title is required for replace action");
            }
        }
        _ => anyhow::bail!("Unknown action: {}", action),
    }

    let new_content = lines.join("\n");
    fs::write(path, new_content)?;

    Ok(())
}

/// Compute semantic analysis: near-duplicates and hidden connections.
/// Uses the precomputed `semantic_edges` table so this is very fast (no embedding computation).
fn compute_semantic_analysis(
    conn: &Connection,
    files_list: &[(String, String)],
    graph: &crate::db::search::GraphData,
) -> anyhow::Result<(Vec<SemanticDuplicateInfo>, Vec<HiddenConnectionInfo>)> {
    // Build a title lookup map: file_path -> title
    let title_map: std::collections::HashMap<&str, &str> = files_list
        .iter()
        .map(|(path, title)| (path.as_str(), title.as_str()))
        .collect();

    // Build a set of existing links (wikilinks + note_relations) for quick lookup
    let mut linked_pairs: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    // From graph edges (wikilinks)
    for edge in &graph.edges {
        let a = edge.source.clone();
        let b = edge.target.clone();
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        linked_pairs.insert((lo, hi));
    }

    // From note_relations
    if let Ok(mut stmt) = conn.prepare(
        "SELECT source_path, target_path FROM note_relations"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                let (a, b) = row;
                let (lo, hi) = if a < b { (a, b) } else { (b, a) };
                linked_pairs.insert((lo, hi));
            }
        }
    }

    // Query all semantic edges, ordered by similarity DESC
    let mut duplicates: Vec<SemanticDuplicateInfo> = Vec::new();
    let mut hidden: Vec<HiddenConnectionInfo> = Vec::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT source_path, target_path, similarity FROM semantic_edges ORDER BY similarity DESC"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let (src, tgt, sim) = row;

                let title_a = title_map.get(src.as_str()).map(|s| s.to_string())
                    .unwrap_or_else(|| src.rsplit(['/', '\\']).next().unwrap_or(&src).replace(".md", ""));
                let title_b = title_map.get(tgt.as_str()).map(|s| s.to_string())
                    .unwrap_or_else(|| tgt.rsplit(['/', '\\']).next().unwrap_or(&tgt).replace(".md", ""));

                // Duplicate: similarity >= 0.92
                if sim >= 0.92 && duplicates.len() < 20 {
                    duplicates.push(SemanticDuplicateInfo {
                        file_path_a: src.clone(),
                        title_a,
                        file_path_b: tgt.clone(),
                        title_b,
                        similarity: (sim * 1000.0).round() / 1000.0,
                    });
                }
                // Hidden connection: 0.75 <= similarity < 0.92 AND not already linked
                else if sim >= 0.75 && sim < 0.92 && hidden.len() < 30 {
                    let (lo, hi) = if src < tgt { (src.clone(), tgt.clone()) } else { (tgt.clone(), src.clone()) };
                    if !linked_pairs.contains(&(lo, hi)) {
                        hidden.push(HiddenConnectionInfo {
                            file_path_a: src.clone(),
                            title_a,
                            file_path_b: tgt.clone(),
                            title_b,
                            similarity: (sim * 1000.0).round() / 1000.0,
                        });
                    }
                }
            }
        }
    }

    Ok((duplicates, hidden))
}
