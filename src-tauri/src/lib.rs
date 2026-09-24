mod kubernetes;

use kubernetes::{commands, KubernetesState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(KubernetesState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_contexts,
            commands::restore_kubeconfig,
            commands::load_kubeconfig,
            commands::connect_context,
            commands::disconnect,
            commands::get_connection,
            commands::list_namespaces,
            commands::list_pods,
            commands::list_deployments,
            commands::list_stateful_sets,
            commands::list_services,
            commands::list_ingresses,
            commands::get_pod,
            commands::get_deployment,
            commands::get_stateful_set,
            commands::get_service,
            commands::get_ingress,
            commands::list_related_pods,
            commands::list_resource_events,
            commands::get_resource_yaml,
            commands::get_pod_logs,
            commands::stream_pod_logs,
            commands::cancel_log_stream,
            commands::watch_resources,
            commands::cancel_resource_watch
        ])
        .run(tauri::generate_context!())
        .expect("Infra failed to start");
}
