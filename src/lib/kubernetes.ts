import { Channel, invoke } from "@tauri-apps/api/core";

export type ErrorKind =
  | "kubeconfig"
  | "connection"
  | "authentication"
  | "permission_denied"
  | "not_found"
  | "api"
  | "not_connected";

export interface InfraError {
  kind: ErrorKind;
  message: string;
}

export interface KubernetesContext {
  name: string;
  cluster: string;
  server: string;
  namespace?: string;
  isCurrent: boolean;
}

export interface ConnectionInfo {
  context: string;
  server: string;
  namespace: string;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  createdAt?: string;
}

export interface ContainerSummary {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  stateReason?: string;
  resources: {
    cpuRequest?: string;
    cpuLimit?: string;
    memoryRequest?: string;
    memoryLimit?: string;
  };
}

export interface PodSummary {
  name: string;
  namespace: string;
  status: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  node?: string;
  createdAt?: string;
  containers: ContainerSummary[];
  labels: Record<string, string>;
}

export interface DeploymentSummary {
  name: string;
  namespace: string;
  desired: number;
  ready: number;
  available: number;
  updated: number;
  image?: string;
  images?: string[];
  createdAt?: string;
  selector: Record<string, string>;
}

export interface StatefulSetSummary extends DeploymentSummary {
  current: number;
  updated: number;
}

export interface ServiceSummary {
  name: string;
  namespace: string;
  serviceType: string;
  clusterIp?: string;
  externalIps: string[];
  ports: string[];
  createdAt?: string;
  selector: Record<string, string>;
}

export interface IngressSummary {
  name: string;
  namespace: string;
  hosts: string[];
  addresses: string[];
  rules: string[];
  createdAt?: string;
}

export interface EventSummary {
  name: string;
  namespace: string;
  eventType: string;
  reason: string;
  message: string;
  objectName: string;
  objectKind: string;
  lastSeen?: string;
}

export interface LogLine {
  streamId: string;
  line: string;
}

export interface NodeSummary {
  name: string;
  ready: boolean;
  version: string;
  capacityCpu?: string;
  capacityMemory?: string;
  allocatableCpu?: string;
  allocatableMemory?: string;
  conditions: Array<{ conditionType: string; status: string; reason?: string; message?: string }>;
  createdAt?: string;
}

export interface ResourceMetric { name: string; namespace?: string; cpu?: string; memory?: string }
export interface RolloutRevision { revision: number; createdAt?: string; images: string[]; template: unknown }
export interface ShellOutput { sessionId: string; text: string; closed: boolean }

export type ResourceKind = "pod" | "deployment" | "statefulset" | "service" | "ingress" | "event";
export type ResourceSummary = PodSummary | DeploymentSummary | StatefulSetSummary | ServiceSummary | IngressSummary | EventSummary;
export interface ResourceWatchMessage {
  subscriptionId: string;
  kind: ResourceKind;
  action: "snapshot" | "upsert" | "delete" | "state";
  resource?: ResourceSummary;
  resources?: ResourceSummary[];
  name?: string;
  namespace?: string;
  status?: "live" | "reconnecting" | "stale" | "polling";
  error?: string;
}

const activeResourceChannels = new Map<string, Channel<ResourceWatchMessage>>();

function assertDesktopRuntime(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    throw {
      kind: "not_connected",
      message: "Run Infra as a desktop app to read your local kubeconfig.",
    } satisfies InfraError;
  }
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  assertDesktopRuntime();
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    if (isInfraError(error)) throw error;
    throw {
      kind: "api",
      message: typeof error === "string" ? error : "The Kubernetes request failed.",
    } satisfies InfraError;
  }
}

function isInfraError(value: unknown): value is InfraError {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

export const kubernetes = {
  listContexts: () => command<KubernetesContext[]>("list_contexts"),
  restoreKubeconfig: () => command<KubernetesContext[]>("restore_kubeconfig"),
  loadKubeconfig: (path: string) => command<KubernetesContext[]>("load_kubeconfig", { path }),
  connect: (context: string) => command<ConnectionInfo>("connect_context", { context }),
  disconnect: () => command<void>("disconnect"),
  connection: () => command<ConnectionInfo | null>("get_connection"),
  namespaces: () => command<NamespaceInfo[]>("list_namespaces"),
  nodes: () => command<NodeSummary[]>("list_nodes"),
  podMetrics: (namespace: string | null) => command<ResourceMetric[]>("list_pod_metrics", { namespace }),
  nodeMetrics: () => command<ResourceMetric[]>("list_node_metrics"),
  restartDeployment: (name: string, namespace: string) => command<void>("restart_deployment", { name, namespace }),
  rolloutRevisions: (name: string, namespace: string) => command<RolloutRevision[]>("list_rollout_revisions", { name, namespace }),
  restoreDeploymentRevision: (name: string, namespace: string, revision: number) => command<void>("restore_deployment_revision", { name, namespace, revision }),
  pods: (namespace: string | null) => command<PodSummary[]>("list_pods", { namespace }),
  deployments: (namespace: string | null) => command<DeploymentSummary[]>("list_deployments", { namespace }),
  statefulSets: (namespace: string | null) => command<StatefulSetSummary[]>("list_stateful_sets", { namespace }),
  services: (namespace: string | null) => command<ServiceSummary[]>("list_services", { namespace }),
  ingresses: (namespace: string | null) => command<IngressSummary[]>("list_ingresses", { namespace }),
  pod: (name: string, namespace: string) => command<PodSummary>("get_pod", { name, namespace }),
  deployment: (name: string, namespace: string) => command<DeploymentSummary>("get_deployment", { name, namespace }),
  statefulSet: (name: string, namespace: string) => command<StatefulSetSummary>("get_stateful_set", { name, namespace }),
  service: (name: string, namespace: string) => command<ServiceSummary>("get_service", { name, namespace }),
  ingress: (name: string, namespace: string) => command<IngressSummary>("get_ingress", { name, namespace }),
  relatedPods: (kind: "deployment" | "statefulset" | "service", name: string, namespace: string) => command<PodSummary[]>("list_related_pods", { kind, name, namespace }),
  events: (name: string, namespace: string) => command<EventSummary[]>("list_resource_events", { name, namespace }),
  yaml: (kind: "pod" | "deployment" | "statefulset" | "service" | "ingress", name: string, namespace: string) =>
    command<string>("get_resource_yaml", { kind, name, namespace }),
  logs: (name: string, namespace: string, container?: string, previous = false) =>
    command<string>("get_pod_logs", { name, namespace, container, previous }),
  streamLogs: async (
    streamId: string,
    name: string,
    namespace: string,
    container: string | undefined,
    onLine: (line: string) => void,
  ) => {
    assertDesktopRuntime();
    const channel = new Channel<LogLine>();
    channel.onmessage = (message) => {
      if (message.streamId === streamId) onLine(message.line);
    };
    return command<void>("stream_pod_logs", { streamId, name, namespace, container, channel });
  },
  cancelLogStream: (streamId: string) => command<void>("cancel_log_stream", { streamId }),
  openShell: async (sessionId: string, name: string, namespace: string, container: string, cols: number, rows: number, onOutput: (output: ShellOutput) => void) => {
    assertDesktopRuntime();
    const channel = new Channel<ShellOutput>();
    channel.onmessage = (message) => { if (message.sessionId === sessionId) onOutput(message); };
    return command<void>("open_pod_shell", { sessionId, name, namespace, container, cols, rows, channel });
  },
  sendShellInput: (sessionId: string, input: string) => command<void>("send_pod_shell_input", { sessionId, input }),
  resizeShell: (sessionId: string, cols: number, rows: number) => command<void>("resize_pod_shell", { sessionId, cols, rows }),
  closeShell: (sessionId: string) => command<void>("close_pod_shell", { sessionId }),
  watchResources: (subscriptionId: string, namespace: string | null, kinds: ResourceKind[], onMessage: (message: ResourceWatchMessage) => void, eventName?: string, eventKind?: string) => {
    const channel = new Channel<ResourceWatchMessage>();
    activeResourceChannels.set(subscriptionId, channel);
    channel.onmessage = (message) => {
      if (message.subscriptionId === subscriptionId) onMessage(message);
    };
    return command<void>("watch_resources", { subscriptionId, namespace, kinds, eventName, eventKind, channel }).then(async () => {
      if (!activeResourceChannels.has(subscriptionId)) await command<void>("cancel_resource_watch", { subscriptionId });
    }).catch((error) => {
      activeResourceChannels.delete(subscriptionId);
      throw error;
    });
  },
  cancelResourceWatch: (subscriptionId: string) => {
    activeResourceChannels.delete(subscriptionId);
    return command<void>("cancel_resource_watch", { subscriptionId });
  },
};

export function errorFrom(value: unknown): InfraError {
  if (isInfraError(value)) return value;
  return { kind: "api", message: "The Kubernetes request failed." };
}
