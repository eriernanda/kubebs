use std::{collections::BTreeMap, fs, path::PathBuf, sync::{atomic::Ordering, Arc}, time::Duration};

use futures::{AsyncBufReadExt, SinkExt, StreamExt, TryStreamExt};
use k8s_openapi::api::{
    apps::v1::{Deployment, ReplicaSet, StatefulSet},
    core::v1::{Event, Namespace, Node, Pod, Service},
    networking::v1::Ingress,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use kube::{
    api::{Api, AttachParams, ListParams, LogParams, Patch, PatchParams, ResourceExt, TerminalSize},
    config::{KubeConfigOptions, Kubeconfig},
    runtime::{watcher, WatchStreamExt},
    Client,
};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use super::{ActiveCluster, KubernetesState};

const SAVED_KUBECONFIG_FILE: &str = "selected-kubeconfig-path";

fn saved_kubeconfig_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SAVED_KUBECONFIG_FILE))
        .map_err(|_| AppError::config())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Kubeconfig,
    Connection,
    Authentication,
    PermissionDenied,
    NotFound,
    Api,
    NotConnected,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    fn config() -> Self {
        Self {
            kind: ErrorKind::Kubeconfig,
            message: "Unable to read that kubeconfig file. Choose a valid Kubernetes config file."
                .into(),
        }
    }

    fn disconnected() -> Self {
        Self {
            kind: ErrorKind::NotConnected,
            message: "Choose a Kubernetes context to connect.".into(),
        }
    }

    fn from_kube(error: &kube::Error) -> Self {
        if let kube::Error::Api(response) = error {
            let (kind, message) = match response.code {
                401 => (
                    ErrorKind::Authentication,
                    "Kubernetes rejected the current credentials.",
                ),
                403 => (
                    ErrorKind::PermissionDenied,
                    "Kubernetes denied this request. Check the context's RBAC permissions.",
                ),
                404 => (ErrorKind::NotFound, "This resource no longer exists."),
                _ => (ErrorKind::Api, "Kubernetes returned an API error."),
            };
            return Self {
                kind,
                message: message.into(),
            };
        }

        Self {
            kind: ErrorKind::Connection,
            message: "Unable to reach the Kubernetes API. Check the cluster address, network, and credentials.".into(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub server: String,
    pub namespace: Option<String>,
    pub is_current: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub context: String,
    pub server: String,
    pub namespace: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceInfo {
    pub name: String,
    pub status: String,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restart_count: i32,
    pub state_reason: Option<String>,
    pub resources: ContainerResourceSummary,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerResourceSummary {
    pub cpu_request: Option<String>,
    pub cpu_limit: Option<String>,
    pub memory_request: Option<String>,
    pub memory_limit: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSummary {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub ready_containers: i32,
    pub total_containers: i32,
    pub restarts: i32,
    pub node: Option<String>,
    pub created_at: Option<String>,
    pub containers: Vec<ContainerSummary>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentSummary {
    pub name: String,
    pub namespace: String,
    pub desired: i32,
    pub ready: i32,
    pub available: i32,
    pub updated: i32,
    pub image: Option<String>,
    pub images: Vec<String>,
    pub created_at: Option<String>,
    pub selector: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatefulSetSummary {
    pub name: String,
    pub namespace: String,
    pub desired: i32,
    pub ready: i32,
    pub current: i32,
    pub updated: i32,
    pub image: Option<String>,
    pub created_at: Option<String>,
    pub selector: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSummary {
    pub name: String,
    pub namespace: String,
    pub service_type: String,
    pub cluster_ip: Option<String>,
    pub external_ips: Vec<String>,
    pub ports: Vec<String>,
    pub created_at: Option<String>,
    pub selector: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressSummary {
    pub name: String,
    pub namespace: String,
    pub hosts: Vec<String>,
    pub addresses: Vec<String>,
    pub rules: Vec<String>,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    pub name: String,
    pub namespace: String,
    pub event_type: String,
    pub reason: String,
    pub message: String,
    pub object_name: String,
    pub object_kind: String,
    pub last_seen: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream_id: String,
    pub line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    pub name: String,
    pub ready: bool,
    pub version: String,
    pub capacity_cpu: Option<String>,
    pub capacity_memory: Option<String>,
    pub allocatable_cpu: Option<String>,
    pub allocatable_memory: Option<String>,
    pub conditions: Vec<NodeCondition>,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutRevision {
    pub revision: i64,
    pub created_at: Option<String>,
    pub images: Vec<String>,
    pub template: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetric {
    pub name: String,
    pub namespace: Option<String>,
    pub cpu: Option<String>,
    pub memory: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutput { pub session_id: String, pub text: String, pub closed: bool }

#[tauri::command]
pub async fn open_pod_shell(session_id: String, name: String, namespace: String, container: String, cols: u16, rows: u16, channel: Channel<ShellOutput>, state: State<'_, KubernetesState>) -> Result<(), AppError> {
    let active = active(&state).await?;
    let api: Api<Pod> = Api::namespaced(active.client, &namespace);
    let params = AttachParams { container: Some(container), stdin: true, stdout: true, stderr: false, tty: true, ..Default::default() };
    let mut process = api.exec(&name, ["/bin/sh", "-i"], &params).await.map_err(|error| {
        let mut app_error = AppError::from_kube(&error);
        app_error.message = format!("Pod exec request failed: {error:?}");
        app_error
    })?;
    let mut stdin = process.stdin().ok_or_else(|| AppError { kind: ErrorKind::Api, message: "The container shell did not provide input.".into() })?;
    let mut stdout = process.stdout().ok_or_else(|| AppError { kind: ErrorKind::Api, message: "The container shell did not provide output.".into() })?;
    let mut terminal_size = process.terminal_size().ok_or_else(|| AppError { kind: ErrorKind::Api, message: "The container shell does not support terminal resizing.".into() })?;
    terminal_size.send(TerminalSize { width: cols.max(1), height: rows.max(1) }).await.map_err(|error| AppError { kind: ErrorKind::Connection, message: format!("Unable to set the initial terminal size: {error}") })?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<String>(64);
    let (resize_sender, mut resize_receiver) = tokio::sync::mpsc::channel::<(u16, u16)>(8);
    let shell_inputs = Arc::clone(&state.shell_inputs);
    let shell_resizes = Arc::clone(&state.shell_resizes);
    shell_inputs.lock().unwrap_or_else(|p| p.into_inner()).insert(session_id.clone(), sender);
    shell_resizes.lock().unwrap_or_else(|p| p.into_inner()).insert(session_id.clone(), resize_sender);
    let id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let _process = process;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buffer = [0u8; 4096];
        loop {
            tokio::select! {
                input = receiver.recv() => match input {
                    Some(input) => if stdin.write_all(input.as_bytes()).await.is_err() { break; },
                    None => break,
                },
                size = resize_receiver.recv() => match size {
                    Some((width, height)) => if terminal_size.send(TerminalSize { width: width.max(1), height: height.max(1) }).await.is_err() { break; },
                    None => break,
                },
                read = stdout.read(&mut buffer) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(count) => if channel.send(ShellOutput { session_id: id.clone(), text: String::from_utf8_lossy(&buffer[..count]).into_owned(), closed: false }).is_err() { break; },
                }
            }
        }
        shell_inputs.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        shell_resizes.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        let _ = channel.send(ShellOutput { session_id: id, text: String::new(), closed: true });
    });
    Ok(())
}

#[tauri::command]
pub async fn send_pod_shell_input(session_id: String, input: String, state: State<'_, KubernetesState>) -> Result<(), AppError> {
    let sender = state.shell_inputs.lock().unwrap_or_else(|p| p.into_inner()).get(&session_id).cloned().ok_or_else(|| AppError { kind: ErrorKind::NotFound, message: "The shell session is no longer connected.".into() })?;
    sender.send(input).await.map_err(|_| AppError { kind: ErrorKind::Connection, message: "The shell session has ended.".into() })
}

#[tauri::command]
pub async fn close_pod_shell(session_id: String, state: State<'_, KubernetesState>) -> Result<(), AppError> {
    state.shell_inputs.lock().unwrap_or_else(|p| p.into_inner()).remove(&session_id);
    state.shell_resizes.lock().unwrap_or_else(|p| p.into_inner()).remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn resize_pod_shell(session_id: String, cols: u16, rows: u16, state: State<'_, KubernetesState>) -> Result<(), AppError> {
    let sender = state.shell_resizes.lock().unwrap_or_else(|p| p.into_inner()).get(&session_id).cloned().ok_or_else(|| AppError { kind: ErrorKind::NotFound, message: "The shell session is no longer connected.".into() })?;
    sender.send((cols.max(1), rows.max(1))).await.map_err(|_| AppError { kind: ErrorKind::Connection, message: "The shell session has ended.".into() })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWatchMessage {
    pub subscription_id: String,
    pub kind: String,
    pub action: String,
    pub resource: Option<serde_json::Value>,
    pub resources: Option<Vec<serde_json::Value>>,
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
}

fn watch_message(subscription_id: &str, kind: &str, action: &str) -> ResourceWatchMessage {
    ResourceWatchMessage {
        subscription_id: subscription_id.into(),
        kind: kind.into(),
        action: action.into(),
        resource: None,
        resources: None,
        name: None,
        namespace: None,
        status: None,
        error: None,
    }
}

fn watch_error_code(error: &watcher::Error) -> Option<u16> {
    match error {
        watcher::Error::InitialListFailed(kube::Error::Api(response))
        | watcher::Error::WatchStartFailed(kube::Error::Api(response))
        | watcher::Error::WatchFailed(kube::Error::Api(response)) => Some(response.code),
        watcher::Error::WatchError(status) => Some(status.code),
        _ => None,
    }
}

fn cancel_resource_watches(state: &KubernetesState) {
    let mut watches = state.resource_watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for token in watches.values() {
        token.cancel();
    }
    watches.clear();
}

fn metadata_time(time: Option<Time>) -> Option<String> {
    time.map(|value| value.0.to_string())
}

fn pod_summary(pod: Pod) -> PodSummary {
    let name = pod.name_any();
    let namespace = pod.namespace().unwrap_or_default();
    let status = pod.status.unwrap_or_default();
    let spec = pod.spec.unwrap_or_default();
    let container_specs = spec.containers;
    let container_statuses = status.container_statuses.unwrap_or_default();
    let containers: Vec<ContainerSummary> = container_specs
        .iter()
        .map(|container| {
            let runtime = container_statuses
                .iter()
                .find(|item| item.name == container.name);
            let waiting_reason = runtime
                .and_then(|item| item.state.as_ref())
                .and_then(|state| state.waiting.as_ref())
                .and_then(|waiting| waiting.reason.clone());
            ContainerSummary {
                name: container.name.clone(),
                image: container
                    .image
                    .clone()
                    .unwrap_or_else(|| "Unknown image".into()),
                ready: runtime.is_some_and(|item| item.ready),
                restart_count: runtime.map_or(0, |item| item.restart_count),
                state_reason: waiting_reason,
                resources: ContainerResourceSummary {
                    cpu_request: container.resources.as_ref().and_then(|resources| resources.requests.as_ref()).and_then(|values| values.get("cpu")).map(|quantity| quantity.0.clone()),
                    cpu_limit: container.resources.as_ref().and_then(|resources| resources.limits.as_ref()).and_then(|values| values.get("cpu")).map(|quantity| quantity.0.clone()),
                    memory_request: container.resources.as_ref().and_then(|resources| resources.requests.as_ref()).and_then(|values| values.get("memory")).map(|quantity| quantity.0.clone()),
                    memory_limit: container.resources.as_ref().and_then(|resources| resources.limits.as_ref()).and_then(|values| values.get("memory")).map(|quantity| quantity.0.clone()),
                },
            }
        })
        .collect();
    let ready_containers = containers.iter().filter(|item| item.ready).count() as i32;
    let restarts = containers.iter().map(|item| item.restart_count).sum();
    let phase = status.phase.unwrap_or_else(|| "Unknown".into());
    let waiting = containers.iter().find_map(|item| item.state_reason.clone());
    let display_status = waiting.unwrap_or(phase);

    PodSummary {
        name,
        namespace,
        status: display_status,
        ready_containers,
        total_containers: containers.len() as i32,
        restarts,
        node: spec.node_name,
        created_at: metadata_time(pod.metadata.creation_timestamp),
        containers,
        labels: pod
            .metadata
            .labels
            .unwrap_or_default()
            .into_iter()
            .collect(),
    }
}

fn deployment_summary(deployment: Deployment) -> DeploymentSummary {
    let name = deployment.name_any();
    let namespace = deployment.namespace().unwrap_or_default();
    let spec = deployment.spec.unwrap_or_default();
    let status = deployment.status.unwrap_or_default();
    let images: Vec<String> = spec
        .template
        .spec
        .as_ref()
        .map(|template| {
            template
                .containers
                .iter()
                .filter_map(|container| container.image.clone())
                .collect()
        })
        .unwrap_or_default();
    let image = images.first().cloned();
    DeploymentSummary {
        name,
        namespace,
        desired: spec.replicas.unwrap_or(1),
        ready: status.ready_replicas.unwrap_or_default(),
        available: status.available_replicas.unwrap_or_default(),
        updated: status.updated_replicas.unwrap_or_default(),
        image,
        images,
        created_at: metadata_time(deployment.metadata.creation_timestamp),
        selector: spec
            .selector
            .match_labels
            .unwrap_or_default()
            .into_iter()
            .collect(),
    }
}

fn stateful_set_summary(stateful_set: StatefulSet) -> StatefulSetSummary {
    let name = stateful_set.name_any();
    let namespace = stateful_set.namespace().unwrap_or_default();
    let spec = stateful_set.spec.unwrap_or_default();
    let status = stateful_set.status.unwrap_or_default();
    let image = spec.template.spec.and_then(|template| {
        template.containers.first().and_then(|container| container.image.clone())
    });
    StatefulSetSummary {
        name,
        namespace,
        desired: spec.replicas.unwrap_or(1),
        ready: status.ready_replicas.unwrap_or_default(),
        current: status.current_replicas.unwrap_or_default(),
        updated: status.updated_replicas.unwrap_or_default(),
        image,
        created_at: metadata_time(stateful_set.metadata.creation_timestamp),
        selector: spec.selector.match_labels.unwrap_or_default().into_iter().collect(),
    }
}

fn service_summary(service: Service) -> ServiceSummary {
    let name = service.name_any();
    let namespace = service.namespace().unwrap_or_default();
    let spec = service.spec.unwrap_or_default();
    let mut external_ips = spec.external_ips.unwrap_or_default();
    if let Some(addresses) = service.status.and_then(|status| status.load_balancer).and_then(|load_balancer| load_balancer.ingress) {
        external_ips.extend(addresses.into_iter().filter_map(|entry| entry.ip.or(entry.hostname)));
    }
    let ports = spec.ports.unwrap_or_default().into_iter().map(|port| {
        let name = port.name.map(|value| format!("{value}: ")).unwrap_or_default();
        let protocol = port.protocol.unwrap_or_else(|| "TCP".into());
        let target = port.target_port.map(|value| match value {
            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(port) => port.to_string(),
            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(value) => value,
        }).map(|value| format!(" → {value}")).unwrap_or_default();
        format!("{name}{} ({protocol}){target}", port.port)
    }).collect();
    ServiceSummary {
        name,
        namespace,
        service_type: spec.type_.unwrap_or_else(|| "ClusterIP".into()),
        cluster_ip: spec.cluster_ip,
        external_ips,
        ports,
        created_at: metadata_time(service.metadata.creation_timestamp),
        selector: spec.selector.unwrap_or_default().into_iter().collect(),
    }
}

fn ingress_summary(ingress: Ingress) -> IngressSummary {
    let name = ingress.name_any();
    let namespace = ingress.namespace().unwrap_or_default();
    let spec = ingress.spec.unwrap_or_default();
    let rules_spec = spec.rules.unwrap_or_default();
    let hosts = rules_spec.iter().map(|rule| rule.host.clone().unwrap_or_else(|| "*".into())).collect::<Vec<_>>();
    let rules = rules_spec.iter().flat_map(|rule| {
        let host = rule.host.as_deref().unwrap_or("*");
        rule.http.as_ref().map(|http| http.paths.iter().map(move |path| {
            let service = path.backend.service.as_ref();
            let service_name = service.map(|item| item.name.as_str()).unwrap_or("unknown");
            let service_port = service.and_then(|item| item.port.as_ref()).and_then(|port| port.number.map(|value| value.to_string()).or_else(|| port.name.clone())).unwrap_or_else(|| "?".into());
            format!("{}{} → {}:{}", host, path.path.as_deref().unwrap_or("/"), service_name, service_port)
        }).collect::<Vec<_>>()).unwrap_or_default()
    }).collect();
    let addresses = ingress.status.and_then(|status| status.load_balancer).map(|load_balancer| load_balancer.ingress.unwrap_or_default().into_iter().filter_map(|entry| entry.ip.or(entry.hostname)).collect()).unwrap_or_default();
    IngressSummary {
        name,
        namespace,
        hosts,
        addresses,
        rules,
        created_at: metadata_time(ingress.metadata.creation_timestamp),
    }
}

fn event_summary(event: Event) -> EventSummary {
    let name = event.name_any();
    let namespace = event.namespace().unwrap_or_default();
    let source = event.involved_object;
    EventSummary {
        name,
        namespace,
        event_type: event.type_.unwrap_or_else(|| "Normal".into()),
        reason: event.reason.unwrap_or_else(|| "Event".into()),
        message: event.message.unwrap_or_default(),
        object_name: source.name.unwrap_or_default(),
        object_kind: source.kind.unwrap_or_else(|| "Resource".into()),
        last_seen: event
            .last_timestamp
            .map(|time| time.0.to_string())
            .or_else(|| event.event_time.map(|time| time.0.to_string()))
            .or_else(|| metadata_time(event.metadata.creation_timestamp)),
    }
}

async fn active(state: &KubernetesState) -> Result<ActiveCluster, AppError> {
    state
        .active
        .read()
        .await
        .clone()
        .ok_or_else(AppError::disconnected)
}

fn resource_api<T>(client: Client, namespace: &str) -> Api<T>
where
    T: kube::Resource<Scope = kube::core::NamespaceResourceScope>,
    T::DynamicType: Default,
{
    Api::namespaced(client, namespace)
}

fn context_infos(config: &Kubeconfig) -> Vec<ContextInfo> {
    let current = config.current_context.as_deref().unwrap_or_default();
    config
        .contexts
        .iter()
        .filter_map(|entry| {
            let context = entry.context.as_ref()?;
            let cluster_name = context.cluster.clone();
            let server = config
                .clusters
                .iter()
                .find(|cluster| cluster.name == cluster_name)
                .and_then(|cluster| cluster.cluster.as_ref())
                .and_then(|cluster| cluster.server.clone())
                .unwrap_or_default();
            Some(ContextInfo {
                is_current: entry.name == current,
                name: entry.name.clone(),
                cluster: cluster_name,
                server,
                namespace: context.namespace.clone(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn list_contexts(
    state: State<'_, KubernetesState>,
) -> Result<Vec<ContextInfo>, AppError> {
    let path = state.kubeconfig_path.read().await.clone();
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    let config = Kubeconfig::read_from(path).map_err(|_| AppError::config())?;
    Ok(context_infos(&config))
}

#[tauri::command]
pub async fn restore_kubeconfig(
    app: AppHandle,
    state: State<'_, KubernetesState>,
) -> Result<Vec<ContextInfo>, AppError> {
    let saved_file = saved_kubeconfig_path(&app)?;
    let path = match fs::read_to_string(saved_file) {
        Ok(path) => PathBuf::from(path.trim()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(AppError::config()),
    };
    let config = Kubeconfig::read_from(&path).map_err(|_| AppError::config())?;
    let contexts = context_infos(&config);
    *state.kubeconfig_path.write().await = Some(path);
    Ok(contexts)
}

#[tauri::command]
pub async fn load_kubeconfig(
    path: String,
    app: AppHandle,
    state: State<'_, KubernetesState>,
) -> Result<Vec<ContextInfo>, AppError> {
    let path = std::path::PathBuf::from(path);
    let config = Kubeconfig::read_from(&path).map_err(|_| AppError::config())?;
    let contexts = context_infos(&config);

    let saved_file = saved_kubeconfig_path(&app)?;
    let config_directory = saved_file.parent().ok_or_else(AppError::config)?;
    fs::create_dir_all(config_directory).map_err(|_| AppError::config())?;
    fs::write(&saved_file, path.to_string_lossy().as_bytes()).map_err(|_| AppError::config())?;

    state.connection_generation.fetch_add(1, Ordering::SeqCst);
    *state.active.write().await = None;
    cancel_resource_watches(&state);
    {
        let mut streams = state
            .log_streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for token in streams.values() {
            token.cancel();
        }
        streams.clear();
    }
    *state.kubeconfig_path.write().await = Some(path);

    Ok(contexts)
}

#[tauri::command]
pub async fn connect_context(
    context: String,
    state: State<'_, KubernetesState>,
) -> Result<ConnectionInfo, AppError> {
    let generation = state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.active.write().await = None;
    cancel_resource_watches(&state);
    {
        let mut streams = state
            .log_streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for token in streams.values() {
            token.cancel();
        }
        streams.clear();
    }

    let path = state
        .kubeconfig_path
        .read()
        .await
        .clone()
        .ok_or_else(AppError::config)?;
    let config = Kubeconfig::read_from(path).map_err(|_| AppError::config())?;
    let selected = config
        .contexts
        .iter()
        .find(|entry| entry.name == context)
        .ok_or_else(AppError::config)?;
    let context_config = selected.context.as_ref().ok_or_else(AppError::config)?;
    let cluster_name = context_config.cluster.clone();
    let server = config
        .clusters
        .iter()
        .find(|cluster| cluster.name == cluster_name)
        .and_then(|cluster| cluster.cluster.as_ref())
        .and_then(|cluster| cluster.server.clone())
        .unwrap_or_default();
    let namespace = context_config
        .namespace
        .clone()
        .unwrap_or_else(|| "default".into());
    let options = KubeConfigOptions {
        context: Some(context.clone()),
        ..Default::default()
    };
    let kube_config = kube::Config::from_custom_kubeconfig(config, &options)
        .await
        .map_err(|_| AppError::config())?;
    let client = Client::try_from(kube_config).map_err(|_| AppError::config())?;
    if state.connection_generation.load(Ordering::SeqCst) != generation {
        return Err(AppError {
            kind: ErrorKind::Connection,
            message: "The context switch was superseded by a newer request.".into(),
        });
    }
    let connection = ConnectionInfo {
        context: context.clone(),
        server: server.clone(),
        namespace: namespace.clone(),
    };
    *state.active.write().await = Some(ActiveCluster {
        client,
        context,
        server,
        default_namespace: namespace,
    });
    Ok(connection)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, KubernetesState>) -> Result<(), AppError> {
    state.connection_generation.fetch_add(1, Ordering::SeqCst);
    *state.active.write().await = None;
    cancel_resource_watches(&state);
    let mut streams = state
        .log_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for token in streams.values() {
        token.cancel();
    }
    streams.clear();
    Ok(())
}

#[tauri::command]
pub async fn get_connection(
    state: State<'_, KubernetesState>,
) -> Result<Option<ConnectionInfo>, AppError> {
    Ok(state
        .active
        .read()
        .await
        .as_ref()
        .map(|active| ConnectionInfo {
            context: active.context.clone(),
            server: active.server.clone(),
            namespace: active.default_namespace.clone(),
        }))
}

#[tauri::command]
pub async fn list_namespaces(
    state: State<'_, KubernetesState>,
) -> Result<Vec<NamespaceInfo>, AppError> {
    let active = active(&state).await?;
    let api: Api<Namespace> = Api::all(active.client);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|error| AppError::from_kube(&error))?;
    Ok(list
        .items
        .into_iter()
        .map(|namespace| NamespaceInfo {
            name: namespace.name_any(),
            status: namespace
                .status
                .and_then(|status| status.phase)
                .unwrap_or_else(|| "Unknown".into()),
            created_at: metadata_time(namespace.metadata.creation_timestamp),
        })
        .collect())
}

#[tauri::command]
pub async fn list_pods(
    namespace: Option<String>,
    state: State<'_, KubernetesState>,
) -> Result<Vec<PodSummary>, AppError> {
    let active = active(&state).await?;
    let api: Api<Pod> = match namespace.as_deref() {
        Some(namespace) => Api::namespaced(active.client, namespace),
        None => Api::all(active.client),
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|error| AppError::from_kube(&error))?;
    Ok(list.items.into_iter().map(pod_summary).collect())
}

#[tauri::command]
pub async fn list_deployments(
    namespace: Option<String>,
    state: State<'_, KubernetesState>,
) -> Result<Vec<DeploymentSummary>, AppError> {
    let active = active(&state).await?;
    let api: Api<Deployment> = match namespace.as_deref() {
        Some(namespace) => Api::namespaced(active.client, namespace),
        None => Api::all(active.client),
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|error| AppError::from_kube(&error))?;
    Ok(list.items.into_iter().map(deployment_summary).collect())
}

#[tauri::command]
pub async fn list_stateful_sets(
    namespace: Option<String>,
    state: State<'_, KubernetesState>,
) -> Result<Vec<StatefulSetSummary>, AppError> {
    let active = active(&state).await?;
    let api: Api<StatefulSet> = match namespace.as_deref() {
        Some(namespace) => Api::namespaced(active.client, namespace),
        None => Api::all(active.client),
    };
    api.list(&ListParams::default()).await
        .map(|list| list.items.into_iter().map(stateful_set_summary).collect())
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn list_services(
    namespace: Option<String>,
    state: State<'_, KubernetesState>,
) -> Result<Vec<ServiceSummary>, AppError> {
    let active = active(&state).await?;
    let api: Api<Service> = match namespace.as_deref() {
        Some(namespace) => Api::namespaced(active.client, namespace),
        None => Api::all(active.client),
    };
    api.list(&ListParams::default()).await
        .map(|list| list.items.into_iter().map(service_summary).collect())
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn list_ingresses(
    namespace: Option<String>,
    state: State<'_, KubernetesState>,
) -> Result<Vec<IngressSummary>, AppError> {
    let active = active(&state).await?;
    let api: Api<Ingress> = match namespace.as_deref() {
        Some(namespace) => Api::namespaced(active.client, namespace),
        None => Api::all(active.client),
    };
    api.list(&ListParams::default()).await
        .map(|list| list.items.into_iter().map(ingress_summary).collect())
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn list_nodes(state: State<'_, KubernetesState>) -> Result<Vec<NodeSummary>, AppError> {
    let active = active(&state).await?;
    let api: Api<Node> = Api::all(active.client);
    let list = api.list(&ListParams::default()).await.map_err(|error| AppError::from_kube(&error))?;
    Ok(list.items.into_iter().map(|node| {
        let name = node.metadata.name.clone().unwrap_or_default();
        let created_at = metadata_time(node.metadata.creation_timestamp.clone());
        let status = node.status.unwrap_or_default();
        let conditions = status.conditions.clone().unwrap_or_default().into_iter().map(|condition| NodeCondition {
            condition_type: condition.type_,
            status: condition.status,
            reason: condition.reason,
            message: condition.message,
        }).collect::<Vec<_>>();
        let ready = status.conditions.unwrap_or_default().iter().any(|condition| condition.type_ == "Ready" && condition.status == "True");
        let capacity = status.capacity.unwrap_or_default();
        let allocatable = status.allocatable.unwrap_or_default();
        NodeSummary {
            name, ready,
            version: status.node_info.map(|info| info.kubelet_version).unwrap_or_default(),
            capacity_cpu: capacity.get("cpu").map(|quantity| quantity.0.clone()),
            capacity_memory: capacity.get("memory").map(|quantity| quantity.0.clone()),
            allocatable_cpu: allocatable.get("cpu").map(|quantity| quantity.0.clone()),
            allocatable_memory: allocatable.get("memory").map(|quantity| quantity.0.clone()),
            conditions,
            created_at,
        }
    }).collect())
}

fn metrics_api(client: Client, namespace: Option<&str>, kind: &str, plural: &str) -> Api<kube::core::DynamicObject> {
    use kube::discovery::ApiResource;
    let resource = ApiResource { group: "metrics.k8s.io".into(), version: "v1beta1".into(), api_version: "metrics.k8s.io/v1beta1".into(), kind: kind.into(), plural: plural.into() };
    match namespace { Some(ns) => Api::namespaced_with(client, ns, &resource), None => Api::all_with(client, &resource) }
}

#[tauri::command]
pub async fn list_pod_metrics(namespace: Option<String>, state: State<'_, KubernetesState>) -> Result<Vec<ResourceMetric>, AppError> {
    let active = active(&state).await?;
    let list = metrics_api(active.client, namespace.as_deref(), "PodMetrics", "pods").list(&ListParams::default()).await.map_err(|error| AppError::from_kube(&error))?;
    Ok(list.items.into_iter().map(|item| {
        let containers = item.data.get("containers").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
        let mut cpu_nanos = 0u128;
        let mut memory_bytes = 0u128;
        let mut has_cpu = false;
        let mut has_memory = false;
        for container in containers {
            if let Some(usage) = container.get("usage") {
                if let Some(value) = usage.get("cpu").and_then(serde_json::Value::as_str) { cpu_nanos += parse_cpu_nanos(value); has_cpu = true; }
                if let Some(value) = usage.get("memory").and_then(serde_json::Value::as_str) { memory_bytes += parse_memory_bytes(value); has_memory = true; }
            }
        }
        ResourceMetric { name: item.metadata.name.unwrap_or_default(), namespace: item.metadata.namespace, cpu: has_cpu.then(|| format_cpu(cpu_nanos)), memory: has_memory.then(|| format_memory(memory_bytes)) }
    }).collect())
}

#[tauri::command]
pub async fn list_node_metrics(state: State<'_, KubernetesState>) -> Result<Vec<ResourceMetric>, AppError> {
    let active = active(&state).await?;
    let list = metrics_api(active.client, None, "NodeMetrics", "nodes").list(&ListParams::default()).await.map_err(|error| AppError::from_kube(&error))?;
    Ok(list.items.into_iter().map(|item| {
        let usage = item.data.get("usage");
        ResourceMetric { name: item.metadata.name.unwrap_or_default(), namespace: None,
            cpu: usage.and_then(|u| u.get("cpu")).and_then(serde_json::Value::as_str).map(|value| format_cpu(parse_cpu_nanos(value))),
            memory: usage.and_then(|u| u.get("memory")).and_then(serde_json::Value::as_str).map(|value| format_memory(parse_memory_bytes(value))) }
    }).collect())
}

fn parse_cpu_nanos(value: &str) -> u128 {
    let (number, scale) = if let Some(number) = value.strip_suffix('n') { (number, 1.0) }
    else if let Some(number) = value.strip_suffix('u') { (number, 1_000.0) }
    else if let Some(number) = value.strip_suffix('m') { (number, 1_000_000.0) }
    else { (value, 1_000_000_000.0) };
    number.parse::<f64>().map(|amount| (amount * scale) as u128).unwrap_or(0)
}

fn parse_memory_bytes(value: &str) -> u128 {
    let units = [("Ei", 1u128 << 60), ("Pi", 1u128 << 50), ("Ti", 1u128 << 40), ("Gi", 1u128 << 30), ("Mi", 1u128 << 20), ("Ki", 1u128 << 10), ("E", 1_000_000_000_000_000_000), ("P", 1_000_000_000_000_000), ("T", 1_000_000_000_000), ("G", 1_000_000_000), ("M", 1_000_000), ("k", 1_000)];
    for (unit, multiplier) in units { if let Some(number) = value.strip_suffix(unit) { return number.parse::<f64>().map(|amount| (amount * multiplier as f64) as u128).unwrap_or(0); } }
    value.parse::<f64>().map(|amount| amount as u128).unwrap_or(0)
}

fn format_cpu(nanos: u128) -> String {
    format!("{:.2}m", nanos as f64 / 1_000_000.0)
}

fn format_memory(bytes: u128) -> String {
    const GIB: u128 = 1 << 30;
    const MIB: u128 = 1 << 20;
    if bytes >= GIB { format!("{:.2}Gi", bytes as f64 / GIB as f64) }
    else if bytes >= MIB { format!("{:.2}Mi", bytes as f64 / MIB as f64) }
    else { format!("{:.2}Ki", bytes as f64 / 1024.0) }
}

#[tauri::command]
pub async fn restart_deployment(name: String, namespace: String, state: State<'_, KubernetesState>) -> Result<(), AppError> {
    let active = active(&state).await?;
    let api: Api<Deployment> = Api::namespaced(active.client, &namespace);
    let timestamp = chrono_placeholder_now();
    api.patch(&name, &PatchParams::default(), &Patch::Merge(serde_json::json!({"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":timestamp}}}}}))).await.map_err(|error| AppError::from_kube(&error))?;
    Ok(())
}

fn chrono_placeholder_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[tauri::command]
pub async fn list_rollout_revisions(name: String, namespace: String, state: State<'_, KubernetesState>) -> Result<Vec<RolloutRevision>, AppError> {
    let active = active(&state).await?;
    let deployments: Api<Deployment> = Api::namespaced(active.client.clone(), &namespace);
    let deployment = deployments.get(&name).await.map_err(|error| AppError::from_kube(&error))?;
    let uid = deployment.metadata.uid.clone().unwrap_or_default();
    let replicasets: Api<ReplicaSet> = Api::namespaced(active.client, &namespace);
    let list = replicasets.list(&ListParams::default()).await.map_err(|error| AppError::from_kube(&error))?;
    let mut revisions: Vec<_> = list.items.into_iter().filter(|rs| rs.metadata.owner_references.as_ref().is_some_and(|owners| owners.iter().any(|owner| owner.uid == uid && owner.kind == "Deployment"))).filter_map(|rs| {
        let revision = rs.metadata.annotations.as_ref()?.get("deployment.kubernetes.io/revision")?.parse::<i64>().ok()?;
        let template = serde_json::to_value(rs.spec?.template).ok()?;
        let images = template.pointer("/spec/containers").and_then(serde_json::Value::as_array).into_iter().flatten().filter_map(|container| container.get("image").and_then(serde_json::Value::as_str).map(str::to_owned)).collect();
        Some(RolloutRevision { revision, created_at: metadata_time(rs.metadata.creation_timestamp), images, template })
    }).collect();
    revisions.sort_by_key(|item| item.revision);
    Ok(revisions)
}

#[tauri::command]
pub async fn restore_deployment_revision(name: String, namespace: String, revision: i64, state: State<'_, KubernetesState>) -> Result<(), AppError> {
    let active = active(&state).await?;
    let deployments: Api<Deployment> = Api::namespaced(active.client.clone(), &namespace);
    let deployment = deployments.get(&name).await.map_err(|error| AppError::from_kube(&error))?;
    let uid = deployment.metadata.uid.clone().unwrap_or_default();
    let replicasets: Api<ReplicaSet> = Api::namespaced(active.client, &namespace);
    let list = replicasets.list(&ListParams::default()).await.map_err(|error| AppError::from_kube(&error))?;
    let template = list.items.into_iter().find(|rs| rs.metadata.owner_references.as_ref().is_some_and(|owners| owners.iter().any(|owner| owner.uid == uid && owner.kind == "Deployment")) && rs.metadata.annotations.as_ref().and_then(|a| a.get("deployment.kubernetes.io/revision")).and_then(|v| v.parse::<i64>().ok()) == Some(revision)).and_then(|rs| rs.spec.map(|spec| spec.template)).ok_or_else(|| AppError { kind: ErrorKind::NotFound, message: "That rollout revision is no longer retained by Kubernetes.".into() })?;
    deployments.patch(&name, &PatchParams::default(), &Patch::Merge(serde_json::json!({"spec":{"template":template}}))).await.map_err(|error| AppError::from_kube(&error))?;
    Ok(())
}

#[tauri::command]
pub async fn watch_resources(
    subscription_id: String,
    namespace: Option<String>,
    kinds: Vec<String>,
    event_name: Option<String>,
    event_kind: Option<String>,
    channel: Channel<ResourceWatchMessage>,
    state: State<'_, KubernetesState>,
) -> Result<(), AppError> {
    let generation = state.connection_generation.load(Ordering::SeqCst);
    let active = active(&state).await?;
    if kinds.is_empty() || kinds.iter().any(|kind| !matches!(kind.as_str(), "pod" | "deployment" | "statefulset" | "service" | "ingress" | "event")) {
        return Err(AppError { kind: ErrorKind::Api, message: "Unknown resource watch type.".into() });
    }
    if kinds.iter().any(|kind| kind == "event") && (namespace.is_none() || event_name.is_none() || event_kind.is_none()) {
        return Err(AppError { kind: ErrorKind::Api, message: "Events need a resource and namespace.".into() });
    }
    let cancellation = CancellationToken::new();
    {
        let mut watches = state.resource_watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = watches.insert(subscription_id.clone(), cancellation.clone()) {
            previous.cancel();
        }
    }
    if state.connection_generation.load(Ordering::SeqCst) != generation {
        cancellation.cancel();
        state.resource_watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&subscription_id);
        return Err(AppError::disconnected());
    }

    macro_rules! start_watch {
        ($kind:literal, $resource:ty, $summary:path, $config:expr) => {{
            let token = cancellation.clone();
            let channel = channel.clone();
            let id = subscription_id.clone();
            let scope = namespace.clone();
            let client = active.client.clone();
            tauri::async_runtime::spawn(async move {
                let api: Api<$resource> = match scope.as_deref() {
                    Some(namespace) => Api::namespaced(client, namespace),
                    None => Api::all(client),
                };
                let stream = watcher::watcher(api.clone(), $config).default_backoff();
                tokio::pin!(stream);
                let mut pending = Vec::new();
                loop {
                    let next = tokio::select! {
                        _ = token.cancelled() => break,
                        next = stream.next() => next,
                    };
                    let message = match next {
                        Some(Ok(watcher::Event::Init)) => {
                            pending.clear();
                            let mut message = watch_message(&id, $kind, "state");
                            message.status = Some("reconnecting".into());
                            message
                        }
                        Some(Ok(watcher::Event::InitApply(item))) => {
                            pending.push(serde_json::to_value($summary(item)).unwrap_or_default());
                            continue;
                        }
                        Some(Ok(watcher::Event::InitDone)) => {
                            let mut message = watch_message(&id, $kind, "snapshot");
                            message.resources = Some(std::mem::take(&mut pending));
                            message.status = Some("live".into());
                            message
                        }
                        Some(Ok(watcher::Event::Apply(item))) => {
                            let mut message = watch_message(&id, $kind, "upsert");
                            message.resource = Some(serde_json::to_value($summary(item)).unwrap_or_default());
                            message.status = Some("live".into());
                            message
                        }
                        Some(Ok(watcher::Event::Delete(item))) => {
                            let mut message = watch_message(&id, $kind, "delete");
                            message.name = Some(item.name_any());
                            message.namespace = item.namespace();
                            message.status = Some("live".into());
                            message
                        }
                        Some(Err(error)) if watch_error_code(&error) == Some(403) => {
                            let mut message = watch_message(&id, $kind, "state");
                            message.status = Some("polling".into());
                            message.error = Some("Watch access denied; refreshing every 30 seconds.".into());
                            if channel.send(message).is_err() { break; }
                            loop {
                                let params = ListParams::default();
                                let listed = tokio::select! {
                                    _ = token.cancelled() => break,
                                    result = api.list(&params) => result,
                                };
                                let mut message = watch_message(&id, $kind, "snapshot");
                                match listed {
                                    Ok(list) => {
                                        message.resources = Some(list.items.into_iter().map(|item| serde_json::to_value($summary(item)).unwrap_or_default()).collect());
                                        message.status = Some("polling".into());
                                    }
                                    Err(error) => {
                                        message.action = "state".into();
                                        message.status = Some("stale".into());
                                        message.error = Some(AppError::from_kube(&error).message);
                                    }
                                }
                                if channel.send(message).is_err() { break; }
                                tokio::select! {
                                    _ = token.cancelled() => break,
                                    _ = tokio::time::sleep(Duration::from_secs(30)) => {},
                                }
                            }
                            break;
                        }
                        Some(Err(error)) => {
                            let mut message = watch_message(&id, $kind, "state");
                            message.status = Some(if watch_error_code(&error) == Some(401) { "stale" } else { "reconnecting" }.into());
                            message.error = Some(match watch_error_code(&error) {
                                Some(401) => "Kubernetes rejected the current credentials.".into(),
                                _ => "Waiting for the Kubernetes API to reconnect.".into(),
                            });
                            if watch_error_code(&error) == Some(401) {
                                let _ = channel.send(message);
                                break;
                            }
                            message
                        }
                        None => {
                            let mut message = watch_message(&id, $kind, "state");
                            message.status = Some("stale".into());
                            message.error = Some("The resource watch stopped.".into());
                            let _ = channel.send(message);
                            break;
                        }
                    };
                    if channel.send(message).is_err() { break; }
                }
            });
        }};
    }

    for kind in kinds {
        match kind.as_str() {
            "pod" => start_watch!("pod", Pod, pod_summary, watcher::Config::default()),
            "deployment" => start_watch!("deployment", Deployment, deployment_summary, watcher::Config::default()),
            "statefulset" => start_watch!("statefulset", StatefulSet, stateful_set_summary, watcher::Config::default()),
            "service" => start_watch!("service", Service, service_summary, watcher::Config::default()),
            "ingress" => start_watch!("ingress", Ingress, ingress_summary, watcher::Config::default()),
            "event" => {
                let selector = format!("involvedObject.name={},involvedObject.kind={}", event_name.as_deref().unwrap_or_default(), event_kind.as_deref().unwrap_or_default());
                start_watch!("event", Event, event_summary, watcher::Config::default().fields(&selector));
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_resource_watch(
    subscription_id: String,
    state: State<'_, KubernetesState>,
) -> Result<(), AppError> {
    let token = state.resource_watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&subscription_id);
    if let Some(token) = token { token.cancel(); }
    Ok(())
}

#[tauri::command]
pub async fn get_pod(
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<PodSummary, AppError> {
    let active = active(&state).await?;
    resource_api::<Pod>(active.client, &namespace)
        .get(&name)
        .await
        .map(pod_summary)
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn get_deployment(
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<DeploymentSummary, AppError> {
    let active = active(&state).await?;
    resource_api::<Deployment>(active.client, &namespace)
        .get(&name)
        .await
        .map(deployment_summary)
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn get_stateful_set(
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<StatefulSetSummary, AppError> {
    let active = active(&state).await?;
    resource_api::<StatefulSet>(active.client, &namespace).get(&name).await
        .map(stateful_set_summary)
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn get_service(
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<ServiceSummary, AppError> {
    let active = active(&state).await?;
    resource_api::<Service>(active.client, &namespace).get(&name).await
        .map(service_summary)
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn get_ingress(
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<IngressSummary, AppError> {
    let active = active(&state).await?;
    resource_api::<Ingress>(active.client, &namespace).get(&name).await
        .map(ingress_summary)
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn list_related_pods(
    kind: String,
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<Vec<PodSummary>, AppError> {
    let active = active(&state).await?;
    let labels = match kind.as_str() {
        "deployment" => resource_api::<Deployment>(active.client.clone(), &namespace).get(&name).await.map_err(|error| AppError::from_kube(&error))?.spec.and_then(|spec| spec.selector.match_labels).unwrap_or_default(),
        "statefulset" => resource_api::<StatefulSet>(active.client.clone(), &namespace).get(&name).await.map_err(|error| AppError::from_kube(&error))?.spec.and_then(|spec| spec.selector.match_labels).unwrap_or_default(),
        "service" => resource_api::<Service>(active.client.clone(), &namespace).get(&name).await.map_err(|error| AppError::from_kube(&error))?.spec.and_then(|spec| spec.selector).unwrap_or_default(),
        _ => return Err(AppError { kind: ErrorKind::Api, message: "Related Pods are unavailable for this resource.".into() }),
    };
    if labels.is_empty() {
        return Ok(Vec::new());
    }
    let selector = labels
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",");
    let params = ListParams::default().labels(&selector);
    resource_api::<Pod>(active.client, &namespace)
        .list(&params)
        .await
        .map(|list| list.items.into_iter().map(pod_summary).collect())
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn list_resource_events(
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<Vec<EventSummary>, AppError> {
    let active = active(&state).await?;
    let params = ListParams::default().fields(&format!("involvedObject.name={name}"));
    resource_api::<Event>(active.client, &namespace)
        .list(&params)
        .await
        .map(|list| list.items.into_iter().map(event_summary).collect())
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn get_resource_yaml(
    kind: String,
    name: String,
    namespace: String,
    state: State<'_, KubernetesState>,
) -> Result<String, AppError> {
    let active = active(&state).await?;
    let yaml = match kind.as_str() {
        "pod" => serde_yaml::to_string(
            &resource_api::<Pod>(active.client, &namespace)
                .get(&name)
                .await
                .map_err(|error| AppError::from_kube(&error))?,
        ),
        "deployment" => serde_yaml::to_string(
            &resource_api::<Deployment>(active.client, &namespace)
                .get(&name)
                .await
                .map_err(|error| AppError::from_kube(&error))?,
        ),
        "statefulset" => serde_yaml::to_string(
            &resource_api::<StatefulSet>(active.client, &namespace)
                .get(&name)
                .await
                .map_err(|error| AppError::from_kube(&error))?,
        ),
        "service" => serde_yaml::to_string(
            &resource_api::<Service>(active.client, &namespace)
                .get(&name)
                .await
                .map_err(|error| AppError::from_kube(&error))?,
        ),
        "ingress" => serde_yaml::to_string(
            &resource_api::<Ingress>(active.client, &namespace)
                .get(&name)
                .await
                .map_err(|error| AppError::from_kube(&error))?,
        ),
        _ => {
            return Err(AppError {
                kind: ErrorKind::Api,
                message: "YAML is unavailable for this resource type.".into(),
            })
        }
    };
    yaml.map_err(|_| AppError {
        kind: ErrorKind::Api,
        message: "Unable to format this resource as YAML.".into(),
    })
}

#[tauri::command]
pub async fn get_pod_logs(
    name: String,
    namespace: String,
    container: Option<String>,
    previous: Option<bool>,
    state: State<'_, KubernetesState>,
) -> Result<String, AppError> {
    let active = active(&state).await?;
    let api: Api<Pod> = Api::namespaced(active.client, &namespace);
    let params = LogParams {
        container,
        previous: previous.unwrap_or(false),
        tail_lines: Some(300),
        timestamps: true,
        ..Default::default()
    };
    api.logs(&name, &params)
        .await
        .map_err(|error| AppError::from_kube(&error))
}

#[tauri::command]
pub async fn stream_pod_logs(
    stream_id: String,
    name: String,
    namespace: String,
    container: Option<String>,
    channel: Channel<LogLine>,
    state: State<'_, KubernetesState>,
) -> Result<(), AppError> {
    let cancellation = CancellationToken::new();
    state
        .log_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(stream_id.clone(), cancellation.clone());
    let active = match active(&state).await {
        Ok(active) => active,
        Err(error) => {
            state
                .log_streams
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&stream_id);
            return Err(error);
        }
    };
    let api: Api<Pod> = Api::namespaced(active.client, &namespace);
    let params = LogParams {
        container,
        follow: true,
        tail_lines: Some(300),
        timestamps: true,
        ..Default::default()
    };
    let result = async {
        let reader = api.log_stream(&name, &params).await.map_err(|error| AppError::from_kube(&error))?;
        let mut lines = Box::pin(reader.lines());
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                line = lines.try_next() => match line {
                    Ok(Some(line)) => channel.send(LogLine { stream_id: stream_id.clone(), line }).map_err(|_| AppError { kind: ErrorKind::Api, message: "The log view closed.".into() })?,
                    Ok(None) => break,
                    Err(_error) => return Err(AppError { kind: ErrorKind::Connection, message: "The log stream ended unexpectedly.".into() }),
                }
            }
        }
        Ok(())
    }.await;
    state
        .log_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&stream_id);
    result
}

#[tauri::command]
pub async fn cancel_log_stream(
    stream_id: String,
    state: State<'_, KubernetesState>,
) -> Result<(), AppError> {
    if let Some(token) = state
        .log_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&stream_id)
    {
        token.cancel();
    }
    Ok(())
}
