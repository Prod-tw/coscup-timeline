use std::{env, net::SocketAddr, path::PathBuf};

use coscup_time_server::{build_app, connect_database};
use tokio::{net::TcpListener, signal};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "coscup_time_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url =
        env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://coscup-time.db".into());
    let dashboard_dir = env::var_os("DASHBOARD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("apps/dashboard/dist"));
    let bind_address: SocketAddr = env::var("BIND_ADDRESS")
        .unwrap_or_else(|_| "0.0.0.0:3000".into())
        .parse()?;

    let pool = connect_database(&database_url).await?;
    let app = build_app(pool, dashboard_dir);
    let listener = TcpListener::bind(bind_address).await?;
    tracing::info!(address = %bind_address, "COSCUP time server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler")
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
