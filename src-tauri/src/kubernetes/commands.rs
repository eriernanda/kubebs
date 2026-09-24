use std::{collections::BTreeMap, fs, path::PathBuf, sync::atomic::Ordering, time::Duration};

use futures::{AsyncBufReadExt, StreamExt, TryStreamExt};
use k8s_openapi::api::{
    apps::v1::{Deployment, StatefulSet},
    core::v1::{Event, Namespace, Pod, Service},
    networking::v1::Ingress,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use kube::{
    api::{Api, ListParams, LogParams, ResourceExt},
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
    let image = spec.template.spec.and_then(|template| {
        template
            .containers
            .first()
            .and_then(|container| container.image.clone())
    });
    DeploymentSummary {
        name,
        namespace,
        desired: spec.replicas.unwrap_or(1),
        ready: status.ready_replicas.unwrap_or_default(),
        available: status.available_replicas.unwrap_or_default(),
        updated: status.updated_replicas.unwrap_or_default(),
        image,
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
