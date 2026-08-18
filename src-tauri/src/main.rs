#![cfg_attr(windows, windows_subsystem = "windows")]

/// Two entry points share one binary:
///
/// * default — launch the Tauri desktop app.
/// * `--mcp-server` — act as an MCP server on stdio so external agents
///   (Claude Desktop, Cursor, …) can search and read the vault. Chosen over a
///   separate `[[bin]]` so users configure the executable they already have
///   installed, and so the two halves can never version-skew.
///
/// Note on Windows: `windows_subsystem = "windows"` only suppresses console
/// *allocation*. When a parent process spawns us with piped stdin/stdout — which
/// is exactly how an MCP client launches a stdio server — those handles are
/// inherited normally, and we get the side benefit of no console window flashing.
///
/// Everything the server logs goes to stderr (`env_logger`'s default). stdout is
/// reserved for JSON-RPC frames; one stray `println!` would corrupt the stream.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args
        .iter()
        .any(|a| a == zettelagent_lib::tools::mcp_server::MCP_SERVER_FLAG)
    {
        env_logger::init();
        if let Err(e) = zettelagent_lib::tools::mcp_server::serve_stdio_from_args(&args) {
            // stderr, never stdout — see above.
            eprintln!("zettelagent --mcp-server: {}", e);
            std::process::exit(1);
        }
        return;
    }

    zettelagent_lib::run()
}
