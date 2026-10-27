#![windows_subsystem = "windows"]

use std::env;
use std::panic;

fn print_help() {
    println!("Ghita Agent v0.7.1");
    println!();
    println!("Usage:");
    println!("  ghita-coding-agent [OPTIONS]");
    println!();
    println!("Options:");
    println!("  --headless, -h    Run in headless/background mode (no UI windows)");
    println!("  --help            Show this help message");
    println!();
    println!("Environment variables:");
    println!("  GHITA_HEADLESS=1  Same as --headless flag");
    println!();
    println!("Examples:");
    println!("  ghita-coding-agent              # Normal GUI mode");
    println!("  ghita-coding-agent --headless   # Background mode");
    println!("  GHITA_HEADLESS=1 ghita-coding-agent  # Background mode via env");
}

fn main() {
    // Parse CLI arguments for headless mode
    let args: Vec<String> = env::args().collect();

    // Check for help flag first
    if args.iter().any(|arg| arg == "--help") {
        print_help();
        return;
    }

    let headless = args.iter().any(|arg| arg == "--headless" || arg == "-h")
        || env::var("GHITA_HEADLESS")
            .map(|v| v == "1" || v.to_lowercase() == "true")
            .unwrap_or(false);

    // Set up panic hook for crash logging in release builds
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");

        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<dyn Any>".to_string()
        };

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let backtrace = std::backtrace::Backtrace::force_capture();

        eprintln!(
            "[GHITA PANIC] Thread '{}': {}\n  at {}\n\nBacktrace:\n{}",
            thread_name, payload, location, backtrace
        );

        // Call the default hook for standard behavior
        default_hook(info);
    }));

    ghita_coding_agent_lib::run(headless)
}
