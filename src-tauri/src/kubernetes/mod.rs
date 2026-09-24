pub mod commands;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicU64, Mutex},
};

use kube::Client;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct ActiveCluster {
    pub client: Client,
    pub context: String,
    pub server: String,
    pub default_namespace: String,
}

#[derive(Default)]
pub struct KubernetesState {
    pub active: RwLock<Option<ActiveCluster>>,
    pub kubeconfig_path: RwLock<Option<PathBuf>>,
    pub log_streams: Mutex<HashMap<String, CancellationToken>>,
    pub resource_watches: Mutex<HashMap<String, CancellationToken>>,
    pub connection_generation: AtomicU64,
}
