import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  FileCode2,
  FolderOpen,
  Layers3,
  ListFilter,
  LoaderCircle,
  Maximize2,
  Minus,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  errorFrom,
  kubernetes,
  type ConnectionInfo,
  type DeploymentSummary,
  type StatefulSetSummary,
  type ServiceSummary,
  type IngressSummary,
  type EventSummary,
  type InfraError,
  type KubernetesContext,
  type NamespaceInfo,
  type PodSummary,
  type ResourceKind,
  type ResourceSummary,
  type ResourceWatchMessage,
  type RolloutRevision,
  type ShellOutput,
  type NodeSummary,
  type ResourceMetric,
} from "./lib/kubernetes";

type Section = "overview" | "workloads" | "network" | "cluster";
type Kind = "pod" | "deployment" | "statefulset" | "service" | "ingress";
type DetailTab = "summary" | "pods" | "events" | "logs" | "yaml" | "shell";
type Selection = { kind: Kind; name: string; namespace: string };
type ResourceTab = { key: string; selection: Selection; detailTab: DetailTab };
type LoadState = "loading" | "ready" | "error";
type WatchStatus = "live" | "reconnecting" | "stale" | "polling";
type RolloutConfirmation = { action: "restart" } | { action: "restore"; revision: number };

const LAST_NAMESPACE_PREFIX = "infra.namespace.";

function formatAge(date?: string): string {
  if (!date) return "—";
  const elapsed = Date.now() - new Date(date).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function podHealthy(pod: PodSummary): boolean {
  return pod.status === "Running" && pod.readyContainers === pod.totalContainers;
}

function deploymentHealthy(deployment: DeploymentSummary): boolean {
  return deployment.ready >= deployment.desired && deployment.available >= deployment.desired;
}

function eventsNewestFirst(items: EventSummary[]): EventSummary[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.lastSeen ?? "") || 0;
    const rightTime = Date.parse(right.lastSeen ?? "") || 0;
    return rightTime - leftTime;
  });
}

function resourceKey(selection: Selection): string {
  return `${selection.kind}:${selection.namespace}/${selection.name}`;
}

function revisionUsesCurrentImages(revision: RolloutRevision, currentImages: string[]): boolean {
  if (!currentImages.length || !revision.images.length) return false;
  const current = [...currentImages].sort();
  const historical = [...revision.images].sort();
  return current.length === historical.length && current.every((image, index) => image === historical[index]);
}

function updateWatchedList<T extends { name: string; namespace: string }>(items: T[], message: ResourceWatchMessage): T[] {
  if (message.action === "snapshot") return (message.resources ?? []) as unknown as T[];
  if (message.action === "delete") return items.filter((item) => item.name !== message.name || item.namespace !== message.namespace);
  if (message.action !== "upsert" || !message.resource) return items;
  const resource = message.resource as unknown as T;
  const index = items.findIndex((item) => item.name === resource.name && item.namespace === resource.namespace);
  if (index < 0) return [...items, resource];
  const next = [...items];
  next[index] = resource;
  return next;
}

function selectedResourceIn(message: ResourceWatchMessage, selection: Selection): ResourceSummary | null {
  if (message.kind !== selection.kind) return null;
  if (message.action === "upsert") {
    const resource = message.resource;
    return resource?.name === selection.name && resource.namespace === selection.namespace ? resource : null;
  }
  if (message.action === "snapshot") return message.resources?.find((item) => item.name === selection.name && item.namespace === selection.namespace) ?? null;
  return null;
}

function statusTone(status: string): "good" | "bad" | "muted" {
  if (["Running", "Healthy", "Active"].includes(status)) return "good";
  if (["Pending", "Unknown"].includes(status)) return "muted";
  return "bad";
}

function isRuntimeAvailable(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export default function App() {
  const [section, setSection] = useState<Section>("overview");
  const [contexts, setContexts] = useState<KubernetesContext[]>([]);
  const [activeContext, setActiveContext] = useState<ConnectionInfo | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
  const [namespace, setNamespace] = useState("all");
  const [pods, setPods] = useState<PodSummary[]>([]);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [statefulSets, setStatefulSets] = useState<StatefulSetSummary[]>([]);
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [ingresses, setIngresses] = useState<IngressSummary[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [resourceTabs, setResourceTabs] = useState<ResourceTab[]>([]);
  const [detailPod, setDetailPod] = useState<PodSummary | null>(null);
  const [detailDeployment, setDetailDeployment] = useState<DeploymentSummary | null>(null);
  const [detailStatefulSet, setDetailStatefulSet] = useState<StatefulSetSummary | null>(null);
  const [detailService, setDetailService] = useState<ServiceSummary | null>(null);
  const [detailIngress, setDetailIngress] = useState<IngressSummary | null>(null);
  const [logPodName, setLogPodName] = useState("");
  const [relatedPods, setRelatedPods] = useState<PodSummary[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventsError, setEventsError] = useState<InfraError | null>(null);
  const [yaml, setYaml] = useState("");
  const [yamlError, setYamlError] = useState<InfraError | null>(null);
  const [relatedError, setRelatedError] = useState<InfraError | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logContainer, setLogContainer] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [showLogTimestamps, setShowLogTimestamps] = useState(false);
  const [logPaused, setLogPaused] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("ready");
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [error, setError] = useState<InfraError | null>(null);
  const [listErrors, setListErrors] = useState<Partial<Record<ResourceKind, InfraError>>>({});
  const [detailError, setDetailError] = useState<InfraError | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | Kind>("all");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarContentVisible = !sidebarCollapsed;
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [detailWidth, setDetailWidth] = useState(480);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [detailResizing, setDetailResizing] = useState(false);
  const [renderedSelection, setRenderedSelection] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [windowVisible, setWindowVisible] = useState(document.visibilityState === "visible");
  const [watchStatuses, setWatchStatuses] = useState<Partial<Record<ResourceKind, WatchStatus>>>({});
  const [watchIssues, setWatchIssues] = useState<Partial<Record<ResourceKind, string>>>({});
  const [yamlRevision, setYamlRevision] = useState(0);
  const [rolloutRevisions, setRolloutRevisions] = useState<RolloutRevision[]>([]);
  const [rolloutError, setRolloutError] = useState<InfraError | null>(null);
  const [rolloutBusy, setRolloutBusy] = useState(false);
  const [rolloutConfirmation, setRolloutConfirmation] = useState<RolloutConfirmation | null>(null);
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState<InfraError | null>(null);
  const [nodeMetrics, setNodeMetrics] = useState<ResourceMetric[]>([]);
  const [podMetrics, setPodMetrics] = useState<ResourceMetric[]>([]);
  const [nodeMetricsUnavailable, setNodeMetricsUnavailable] = useState(false);
  const [podMetricsUnavailable, setPodMetricsUnavailable] = useState(false);
  const [resourcePodMetrics, setResourcePodMetrics] = useState<ResourceMetric[]>([]);
  const [resourceMetricsUnavailable, setResourceMetricsUnavailable] = useState(false);
  const [shellSession, setShellSession] = useState<string | null>(null);
  const [shellError, setShellError] = useState<InfraError | null>(null);
  const [shellPod, setShellPod] = useState("");
  const [shellContainer, setShellContainer] = useState("");
  const reportShellError = useCallback((cause: unknown) => setShellError(errorFrom(cause)), []);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);
  const watchSubscription = useRef<string | null>(null);
  const eventSubscription = useRef<string | null>(null);
  const selectedRef = useRef<Selection | null>(null);
  const renderedSelectionRef = useRef<Selection | null>(null);
  const logStreamId = useRef<string | null>(null);
  const shellSessionRef = useRef<string | null>(null);
  const rolloutDialog = useRef<HTMLDialogElement>(null);
  const shellWriteRef = useRef<((text: string) => void) | null>(null);
  const loadedDetailKey = useRef<string | null>(null);
  const logPane = useRef<HTMLDivElement>(null);
  const contextMenu = useRef<HTMLDivElement>(null);
  const detailResize = useRef<{ pointerId: number } | null>(null);
  selectedRef.current = selection;
  shellSessionRef.current = shellSession;

  useEffect(() => {
    if (sidebarCollapsed) setContextMenuOpen(false);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isRuntimeAvailable()) return;
    const currentWindow = getCurrentWindow();
    void currentWindow.isMaximized().then(setWindowMaximized).catch(() => undefined);
    const unlisten = currentWindow.onResized(() => {
      void currentWindow.isMaximized().then(setWindowMaximized).catch(() => undefined);
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    const disableNativeContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", disableNativeContextMenu);
    return () => document.removeEventListener("contextmenu", disableNativeContextMenu);
  }, []);

  useLayoutEffect(() => {
    let frame = 0;
    let timer = 0;
    if (selection) {
      const wasClosed = !renderedSelectionRef.current;
      renderedSelectionRef.current = selection;
      setRenderedSelection(selection);
      if (wasClosed) {
        setPanelOpen(false);
        frame = window.requestAnimationFrame(() => setPanelOpen(true));
      } else setPanelOpen(true);
    } else if (renderedSelectionRef.current) {
      setPanelOpen(false);
      timer = window.setTimeout(() => {
        if (!selectedRef.current) {
          renderedSelectionRef.current = null;
          setRenderedSelection(null);
        }
      }, 260);
    }
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [selection]);

  useEffect(() => {
    if (!shellSession) return;
    return () => { void kubernetes.closeShell(shellSession).catch(() => undefined); };
  }, [selection, shellSession]);

  const startPodShell = async (podName: string, container: string, cols: number, rows: number) => {
    if (!selection || !container) return;
    if (shellSession) await kubernetes.closeShell(shellSession).catch(() => undefined);
    const sessionId = crypto.randomUUID();
    setShellError(null); setShellSession(sessionId); setShellPod(podName); setShellContainer(container);
    try {
      await kubernetes.openShell(sessionId, podName, selection.namespace, container, cols, rows, (message: ShellOutput) => {
        if (message.closed) { setShellSession(null); return; }
        shellWriteRef.current?.(message.text);
      });
    } catch (cause) { setShellError(errorFrom(cause)); setShellSession(null); }
  };

  const loadLists = useCallback(async (activeNamespace: string, request: number) => {
    setLoadState("loading");
    setError(null);
    setListErrors({});
    try {
      const scope = activeNamespace === "all" ? null : activeNamespace;
      const results = await Promise.allSettled([
        kubernetes.pods(scope),
        kubernetes.deployments(scope),
        kubernetes.statefulSets(scope),
        kubernetes.services(scope),
        kubernetes.ingresses(scope),
      ]);
      if (request !== requestId.current) return;
      const kinds: ResourceKind[] = ["pod", "deployment", "statefulset", "service", "ingress"];
      const failures: Partial<Record<ResourceKind, InfraError>> = {};
      results.forEach((result, index) => { if (result.status === "rejected") failures[kinds[index]] = errorFrom(result.reason); });
      setListErrors(failures);
      if (results.every((result) => result.status === "rejected")) throw results[0].status === "rejected" ? results[0].reason : undefined;
      const [podsResult, deploymentsResult, statefulSetsResult, servicesResult, ingressesResult] = results;
      setPods(podsResult.status === "fulfilled" ? podsResult.value : []);
      setDeployments(deploymentsResult.status === "fulfilled" ? deploymentsResult.value : []);
      setStatefulSets(statefulSetsResult.status === "fulfilled" ? statefulSetsResult.value : []);
      setServices(servicesResult.status === "fulfilled" ? servicesResult.value : []);
      setIngresses(ingressesResult.status === "fulfilled" ? ingressesResult.value : []);
      setError(null);
      setLastUpdated(new Date());
      setLoadState("ready");
    } catch (cause) {
      if (request !== requestId.current) return;
      setError(errorFrom(cause));
      setLoadState("error");
    }
  }, []);

  const connect = useCallback(async (contextName: string, preferredNamespace?: string) => {
    const request = ++requestId.current;
    setLoadState("loading");
    setError(null);
    setSelection(null);
    setResourceTabs([]);
    setActiveContext(null);
    setPods([]);
    setDeployments([]);
    setStatefulSets([]);
    setServices([]);
    setIngresses([]);
    try {
      const connection = await kubernetes.connect(contextName);
      if (request !== requestId.current) return;
      const nextNamespaces = await kubernetes.namespaces();
      if (request !== requestId.current) return;
      setActiveContext(connection);
      setNamespaces(nextNamespaces);
      const storedNamespace = localStorage.getItem(`${LAST_NAMESPACE_PREFIX}${contextName}`);
      const proposed = preferredNamespace ?? storedNamespace ?? connection.namespace;
      const nextNamespace = proposed === "all" || nextNamespaces.some((item) => item.name === proposed)
        ? proposed
        : nextNamespaces.some((item) => item.name === connection.namespace) ? connection.namespace : "all";
      setNamespace(nextNamespace);
      localStorage.setItem(`${LAST_NAMESPACE_PREFIX}${contextName}`, nextNamespace);
      await loadLists(nextNamespace, request);
    } catch (cause) {
      if (request !== requestId.current) return;
      setError(errorFrom(cause));
      setLoadState("error");
    }
  }, [loadLists]);

  useEffect(() => {
    if (!activeContext) return;
    let cancelled = false;
    setNodes([]);
    setNodesError(null);
    setNodesLoading(true);
    void kubernetes.nodes().then((items) => { if (!cancelled) { setNodes(items); setNodesError(null); } }).catch((cause) => { if (!cancelled) { setNodes([]); setNodesError(errorFrom(cause)); } }).finally(() => { if (!cancelled) setNodesLoading(false); });
    return () => { cancelled = true; };
  }, [activeContext, namespace]);

  useEffect(() => {
    if (!activeContext || !windowVisible) return;
    let cancelled = false;
    let requestInFlight = false;
    const listNamespace = namespace === "all" ? null : namespace;
    const hasMetricSelection = Boolean(selection && ["pod", "deployment"].includes(selection.kind));
    const selectedNamespace = hasMetricSelection ? selection?.namespace ?? null : null;
    const selectedCoveredByList = selectedNamespace === null || listNamespace === null || selectedNamespace === listNamespace;
    const refreshMetrics = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      const listMetricsRequest = kubernetes.podMetrics(listNamespace);
      const detailMetricsRequest = selectedCoveredByList || selectedNamespace === null
        ? listMetricsRequest
        : kubernetes.podMetrics(selectedNamespace);
      const [nodeResult, podResult, detailResult] = await Promise.allSettled([
        kubernetes.nodeMetrics(),
        listMetricsRequest,
        detailMetricsRequest,
      ]);
      requestInFlight = false;
      if (cancelled) return;

      if (nodeResult.status === "fulfilled") {
        setNodeMetrics(nodeResult.value);
        setNodeMetricsUnavailable(false);
      } else {
        setNodeMetrics([]);
        setNodeMetricsUnavailable(true);
      }

      if (podResult.status === "fulfilled") {
        setPodMetrics(podResult.value);
        setPodMetricsUnavailable(false);
      } else {
        setPodMetrics([]);
        setPodMetricsUnavailable(true);
      }

      if (hasMetricSelection && detailResult.status === "fulfilled") {
        setResourcePodMetrics(detailResult.value);
        setResourceMetricsUnavailable(false);
      } else if (hasMetricSelection) {
        setResourcePodMetrics([]);
        setResourceMetricsUnavailable(true);
      } else {
        setResourcePodMetrics([]);
        setResourceMetricsUnavailable(false);
      }
    };

    setNodeMetrics([]);
    setPodMetrics([]);
    setResourcePodMetrics([]);
    setResourceMetricsUnavailable(false);
    setNodeMetricsUnavailable(false);
    setPodMetricsUnavailable(false);
    void refreshMetrics();
    const interval = window.setInterval(() => void refreshMetrics(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeContext, namespace, selection, windowVisible]);

  const openKubeconfig = useCallback(async () => {
    try {
      const selection = await open({
        multiple: false,
        directory: false,
        title: "Open Kubernetes config",
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;

      const request = ++requestId.current;
      setLoadState("loading");
      setError(null);
      setActiveContext(null);
      setSelection(null);
      setResourceTabs([]);
      setContexts([]);
      setNamespaces([]);
      setPods([]);
      setDeployments([]);
      setStatefulSets([]);
      setServices([]);
      setIngresses([]);
      const available = await kubernetes.loadKubeconfig(path);
      if (request !== requestId.current) return;
      setContexts(available);
      if (available.length === 0) {
        setError({ kind: "kubeconfig", message: "This file has no Kubernetes contexts. Choose another kubeconfig file." });
        setLoadState("ready");
      } else {
        const context = available.find((item) => item.isCurrent) ?? available[0];
        await connect(context.name);
      }
    } catch (cause) {
      setError(errorFrom(cause));
      setLoadState("ready");
    }
  }, [connect]);

  useEffect(() => {
    if (!isRuntimeAvailable()) return;
    let cancelled = false;
    setLoadState("loading");
    void kubernetes.restoreKubeconfig().then((available) => {
      if (cancelled) return;
      setContexts(available);
      if (available.length === 0) {
        setLoadState("ready");
        return;
      }
      const context = available.find((item) => item.isCurrent) ?? available[0];
      void connect(context.name);
    }).catch((cause) => {
      if (cancelled) return;
      setError(errorFrom(cause));
      setLoadState("ready");
    });
    return () => { cancelled = true; };
  }, [connect]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!contextMenu.current?.contains(event.target as Node)) setContextMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenuOpen]);

  useEffect(() => {
    const updateVisibility = () => {
      setWatchStatuses({});
      setWindowVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const watchedKinds = useMemo(() => {
    const kinds: ResourceKind[] = section === "network" ? ["service", "ingress"] : section === "workloads" ? ["pod", "deployment", "statefulset"] : ["pod", "deployment"];
    if (selection && !kinds.includes(selection.kind)) kinds.push(selection.kind);
    if (selection && ["deployment", "statefulset", "service"].includes(selection.kind) && !kinds.includes("pod")) kinds.push("pod");
    return kinds;
  }, [section, selection]);
  const watchedKindsKey = watchedKinds.join(",");

  useEffect(() => {
    if (!activeContext || loadState !== "ready" || !windowVisible) return;
    const subscriptionId = crypto.randomUUID();
    watchSubscription.current = subscriptionId;
    const kinds = watchedKindsKey.split(",") as ResourceKind[];
    setWatchStatuses({});
    setWatchIssues({});
    void kubernetes.watchResources(subscriptionId, namespace === "all" ? null : namespace, kinds, (message) => {
      if (watchSubscription.current !== subscriptionId) return;
      if (message.status) setWatchStatuses((current) => ({ ...current, [message.kind]: message.status }));
      setWatchIssues((current) => {
        if (current[message.kind] === message.error) return current;
        return { ...current, [message.kind]: message.error };
      });
      if (message.action === "state") return;
      setListErrors((current) => {
        if (!current[message.kind]) return current;
        const next = { ...current };
        delete next[message.kind];
        return next;
      });
      if (message.kind === "pod") setPods((items) => updateWatchedList(items, message));
      if (message.kind === "deployment") setDeployments((items) => updateWatchedList(items, message));
      if (message.kind === "statefulset") setStatefulSets((items) => updateWatchedList(items, message));
      if (message.kind === "service") setServices((items) => updateWatchedList(items, message));
      if (message.kind === "ingress") setIngresses((items) => updateWatchedList(items, message));
      setLastUpdated(new Date());
      const currentSelection = selectedRef.current;
      if (!currentSelection || currentSelection.kind !== message.kind) return;
      const resource = selectedResourceIn(message, currentSelection);
      if (resource) {
        if (message.kind === "pod") setDetailPod(resource as PodSummary);
        if (message.kind === "deployment") setDetailDeployment(resource as DeploymentSummary);
        if (message.kind === "statefulset") setDetailStatefulSet(resource as StatefulSetSummary);
        if (message.kind === "service") setDetailService(resource as ServiceSummary);
        if (message.kind === "ingress") setDetailIngress(resource as IngressSummary);
        setYamlRevision((revision) => revision + 1);
      } else if (message.action === "delete" && message.name === currentSelection.name && message.namespace === currentSelection.namespace || message.action === "snapshot" && !resource) {
        setDetailError({ kind: "not_found", message: "This resource no longer exists." });
        setDetailState("error");
      }
    }).catch((cause) => {
      if (watchSubscription.current !== subscriptionId) return;
      const message = errorFrom(cause).message;
      const statuses: Partial<Record<ResourceKind, WatchStatus>> = {};
      const issues: Partial<Record<ResourceKind, string>> = {};
      for (const kind of kinds) { statuses[kind] = "stale"; issues[kind] = message; }
      setWatchStatuses(statuses);
      setWatchIssues(issues);
    });
    return () => {
      if (watchSubscription.current === subscriptionId) watchSubscription.current = null;
      void kubernetes.cancelResourceWatch(subscriptionId).catch(() => undefined);
    };
  }, [activeContext, loadState, namespace, watchedKindsKey, windowVisible]);

  useEffect(() => {
    if (!activeContext || !windowVisible || !selection || detailTab !== "events" || detailState !== "ready") return;
    const subscriptionId = crypto.randomUUID();
    eventSubscription.current = subscriptionId;
    const eventKind = { pod: "Pod", deployment: "Deployment", statefulset: "StatefulSet", service: "Service", ingress: "Ingress" }[selection.kind];
    void kubernetes.watchResources(subscriptionId, selection.namespace, ["event"], (message) => {
      if (eventSubscription.current !== subscriptionId) return;
      if (message.action === "snapshot" || message.action === "upsert" || message.action === "delete") {
        setEvents((items) => eventsNewestFirst(updateWatchedList(items, message)));
        setEventsError(null);
      } else if (message.status === "stale") {
        setEventsError({ kind: "connection", message: message.error ?? "Events are not current." });
      }
    }, selection.name, eventKind).catch((cause) => {
      if (eventSubscription.current === subscriptionId) setEventsError(errorFrom(cause));
    });
    return () => {
      if (eventSubscription.current === subscriptionId) eventSubscription.current = null;
      void kubernetes.cancelResourceWatch(subscriptionId).catch(() => undefined);
    };
  }, [activeContext, detailState, detailTab, selection, windowVisible]);

  useEffect(() => {
    if (!selection) {
      loadedDetailKey.current = null;
      return;
    }
    const selectionKey = `${selection.kind}:${selection.namespace}/${selection.name}`;
    loadedDetailKey.current = null;
    const request = ++detailRequestId.current;
    setDetailState("loading");
    setDetailError(null);
    setDetailPod(null);
    setDetailDeployment(null);
    setDetailStatefulSet(null);
    setDetailService(null);
    setDetailIngress(null);
    setRelatedPods([]);
    setEvents([]);
    setEventsError(null);
    setYaml("");
    setYamlError(null);
    setRelatedError(null);
    setRolloutRevisions([]);
    setRolloutError(null);
    setLogPaused(false);
    const applyCommon = (eventsResult: PromiseSettledResult<EventSummary[]>, yamlResult: PromiseSettledResult<string>) => {
      if (eventsResult.status === "fulfilled") setEvents(eventsNewestFirst(eventsResult.value));
      else setEventsError(errorFrom(eventsResult.reason));
      if (yamlResult.status === "fulfilled") setYaml(yamlResult.value);
      else setYamlError(errorFrom(yamlResult.reason));
    };
    const tasks = selection.kind === "pod"
      ? Promise.allSettled([
          kubernetes.pod(selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("pod", selection.name, selection.namespace),
        ]).then(([podResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (podResult.status === "rejected") throw podResult.reason;
          setDetailPod(podResult.value);
          setLogContainer(podResult.value.containers[0]?.name ?? "");
          setLogPodName(podResult.value.name);
          applyCommon(eventsResult, yamlResult);
        })
      : selection.kind === "deployment"
      ? Promise.allSettled([
          kubernetes.deployment(selection.name, selection.namespace),
          kubernetes.relatedPods("deployment", selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("deployment", selection.name, selection.namespace),
        ]).then(([deploymentResult, podsResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (deploymentResult.status === "rejected") throw deploymentResult.reason;
          setDetailDeployment(deploymentResult.value);
          if (podsResult.status === "fulfilled") {
            setRelatedPods(podsResult.value);
            setLogPodName(podsResult.value[0]?.name ?? "");
            setLogContainer(podsResult.value[0]?.containers[0]?.name ?? "");
          }
          else setRelatedError(errorFrom(podsResult.reason));
          applyCommon(eventsResult, yamlResult);
        })
      : selection.kind === "statefulset"
      ? Promise.allSettled([
          kubernetes.statefulSet(selection.name, selection.namespace),
          kubernetes.relatedPods("statefulset", selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("statefulset", selection.name, selection.namespace),
        ]).then(([resourceResult, podsResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (resourceResult.status === "rejected") throw resourceResult.reason;
          setDetailStatefulSet(resourceResult.value);
          if (podsResult.status === "fulfilled") {
            setRelatedPods(podsResult.value);
            setLogPodName(podsResult.value[0]?.name ?? "");
            setLogContainer(podsResult.value[0]?.containers[0]?.name ?? "");
          } else setRelatedError(errorFrom(podsResult.reason));
          applyCommon(eventsResult, yamlResult);
        })
      : selection.kind === "service"
      ? Promise.allSettled([
          kubernetes.service(selection.name, selection.namespace),
          kubernetes.relatedPods("service", selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("service", selection.name, selection.namespace),
        ]).then(([resourceResult, podsResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (resourceResult.status === "rejected") throw resourceResult.reason;
          setDetailService(resourceResult.value);
          if (podsResult.status === "fulfilled") setRelatedPods(podsResult.value);
          else setRelatedError(errorFrom(podsResult.reason));
          applyCommon(eventsResult, yamlResult);
        })
      : Promise.allSettled([
          kubernetes.ingress(selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("ingress", selection.name, selection.namespace),
        ]).then(([resourceResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (resourceResult.status === "rejected") throw resourceResult.reason;
          setDetailIngress(resourceResult.value);
          applyCommon(eventsResult, yamlResult);
        });
    void tasks.then(() => {
      if (request === detailRequestId.current) {
        loadedDetailKey.current = selectionKey;
        setDetailState("ready");
      }
    }).catch((cause) => {
      if (request !== detailRequestId.current) return;
      setDetailError(errorFrom(cause));
      setDetailState("error");
    });
    return () => {
      detailRequestId.current += 1;
      if (logStreamId.current) {
        const streamId = logStreamId.current;
        logStreamId.current = null;
        void kubernetes.cancelLogStream(streamId).catch(() => undefined);
      }
    };
  }, [selection]);

  useEffect(() => {
    if (!selection || selection.kind !== "deployment" || !activeContext) return;
    let cancelled = false;
    void kubernetes.rolloutRevisions(selection.name, selection.namespace).then((items) => { if (!cancelled) { setRolloutRevisions(items); setRolloutError(null); } }).catch((cause) => { if (!cancelled) setRolloutError(errorFrom(cause)); });
    return () => { cancelled = true; };
  }, [activeContext, selection]);

  useEffect(() => {
    const dialog = rolloutDialog.current;
    if (!dialog) return;
    if (rolloutConfirmation && !dialog.open) dialog.showModal();
    if (!rolloutConfirmation && dialog.open) dialog.close();
  }, [rolloutConfirmation]);

  const restartDeployment = () => {
    if (!selection || selection.kind !== "deployment" || !activeContext) return;
    setRolloutConfirmation({ action: "restart" });
  };

  const restoreRollout = (revision: number) => {
    if (!selection || selection.kind !== "deployment" || !activeContext) return;
    setRolloutConfirmation({ action: "restore", revision });
  };

  const confirmRolloutAction = async () => {
    const confirmation = rolloutConfirmation;
    if (!selection || selection.kind !== "deployment" || !activeContext || !confirmation) return;
    const target = selection;
    setRolloutConfirmation(null);
    setRolloutBusy(true);
    try {
      if (confirmation.action === "restart") {
        await kubernetes.restartDeployment(target.name, target.namespace);
      } else {
        await kubernetes.restoreDeploymentRevision(target.name, target.namespace, confirmation.revision);
      }
      setRolloutRevisions(await kubernetes.rolloutRevisions(target.name, target.namespace));
      refresh();
    } catch (cause) { setRolloutError(errorFrom(cause)); }
    finally { setRolloutBusy(false); }
  };

  useEffect(() => {
    if (!selection || !["deployment", "statefulset", "service"].includes(selection.kind)) return;
    const selector = selection.kind === "deployment" ? detailDeployment?.selector : selection.kind === "statefulset" ? detailStatefulSet?.selector : detailService?.selector;
    if (!selector) return;
    const labels = Object.entries(selector);
    setRelatedPods(labels.length ? pods.filter((pod) => pod.namespace === selection.namespace && labels.every(([key, value]) => pod.labels[key] === value)) : []);
  }, [detailDeployment, detailService, detailStatefulSet, pods, selection]);

  useEffect(() => {
    if (!selection || detailTab !== "yaml" || detailState !== "ready" || !activeContext) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void kubernetes.yaml(selection.kind, selection.name, selection.namespace).then((value) => {
        if (!cancelled) { setYaml(value); setYamlError(null); }
      }).catch((cause) => {
        if (!cancelled) setYamlError(errorFrom(cause));
      });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeContext, detailState, detailTab, selection, yamlRevision]);

  useLayoutEffect(() => {
    setLogs([]);
    setShellPod("");
    setShellContainer("");
    if (shellSessionRef.current) {
      void kubernetes.closeShell(shellSessionRef.current).catch(() => undefined);
      setShellSession(null);
    }
    if (selection) {
      setLogPodName("");
      setLogContainer("");
    }
    setDetailError(null);
    if (logStreamId.current) {
      const streamId = logStreamId.current;
      logStreamId.current = null;
      void kubernetes.cancelLogStream(streamId).catch(() => undefined);
    }
  }, [selection]);

  useLayoutEffect(() => {
    setLogs([]);
    setDetailError(null);
    if (logStreamId.current) {
      const streamId = logStreamId.current;
      logStreamId.current = null;
      void kubernetes.cancelLogStream(streamId).catch(() => undefined);
    }
  }, [logPodName, logContainer]);

  const logTargetName = selection?.kind === "pod" ? detailPod?.name : relatedPods.find((item) => item.name === logPodName)?.name ?? relatedPods[0]?.name;
  const logTargetNamespace = selection?.kind === "pod" ? detailPod?.namespace : relatedPods.find((item) => item.name === logTargetName)?.namespace;

  useEffect(() => {
    if (!selection || !["pod", "deployment", "statefulset"].includes(selection.kind) || detailTab !== "logs" || detailState !== "ready" || logPaused) return;
    const selectionKey = `${selection.kind}:${selection.namespace}/${selection.name}`;
    if (loadedDetailKey.current !== selectionKey) return;
    if (!logTargetName || !logTargetNamespace) return;
    const streamId = crypto.randomUUID();
    logStreamId.current = streamId;
    void kubernetes.streamLogs(streamId, logTargetName, logTargetNamespace, logContainer || undefined, (line) => {
      if (logStreamId.current !== streamId) return;
      setLogs((existing) => [...existing.slice(-1199), line]);
    }).catch((cause) => {
      setDetailError(errorFrom(cause));
    }).finally(() => {
      if (logStreamId.current === streamId) logStreamId.current = null;
    });
    return () => {
      if (logStreamId.current === streamId) logStreamId.current = null;
      void kubernetes.cancelLogStream(streamId).catch(() => undefined);
    };
  }, [detailState, detailTab, logContainer, logPaused, logTargetName, logTargetNamespace, selection]);

  useLayoutEffect(() => {
    if (logPane.current) logPane.current.scrollTop = logPane.current.scrollHeight;
  }, [detailTab, logs, logContainer, logPodName, selection]);

  const problemPods = useMemo(() => pods.filter((pod) => !podHealthy(pod)), [pods]);
  const unhealthyDeployments = useMemo(() => deployments.filter((item) => !deploymentHealthy(item)), [deployments]);
  const refresh = () => {
    if (!activeContext) return;
    void loadLists(namespace, ++requestId.current);
    void kubernetes.nodes().then(setNodes).catch((cause) => setNodesError(errorFrom(cause)));
    Promise.allSettled([kubernetes.nodeMetrics(), kubernetes.podMetrics(namespace === "all" ? null : namespace)]).then(([nodeResult, podResult]) => {
      if (nodeResult.status === "fulfilled") setNodeMetrics(nodeResult.value); else setNodeMetricsUnavailable(true);
      if (podResult.status === "fulfilled") setPodMetrics(podResult.value); else setPodMetricsUnavailable(true);
    });
    if (selection && ["pod", "deployment"].includes(selection.kind)) void kubernetes.podMetrics(selection.namespace).then((items) => { setResourcePodMetrics(items); setResourceMetricsUnavailable(false); }).catch(() => setResourceMetricsUnavailable(true));
  };

  const chooseNamespace = (nextNamespace: string) => {
    setNamespace(nextNamespace);
    setPods([]);
    setDeployments([]);
    setStatefulSets([]);
    setServices([]);
    setIngresses([]);
    if (activeContext) {
      localStorage.setItem(`${LAST_NAMESPACE_PREFIX}${activeContext.context}`, nextNamespace);
      void loadLists(nextNamespace, ++requestId.current);
    }
  };

  const openResource = (kind: Kind, name: string, resourceNamespace: string) => {
    const nextSelection = { kind, name, namespace: resourceNamespace };
    const key = resourceKey(nextSelection);
    setResourceTabs((current) => current.some((tab) => tab.key === key) ? current : [...current, { key, selection: nextSelection, detailTab: "summary" }]);
    setSelection(nextSelection);
    setDetailTab(resourceTabs.find((tab) => tab.key === key)?.detailTab ?? "summary");
  };

  const selectDetailTab = (tab: DetailTab) => {
    setDetailTab(tab);
    if (!selection) return;
    const key = resourceKey(selection);
    setResourceTabs((current) => current.map((item) => item.key === key ? { ...item, detailTab: tab } : item));
  };

  const closeDetails = () => {
    setDetailResizing(false);
    if (!selection) return;
    const key = resourceKey(selection);
    const next = resourceTabs.filter((item) => item.key !== key);
    setResourceTabs(next);
    const fallback = next.at(-1);
    setSelection(fallback?.selection ?? null);
    setDetailTab(fallback?.detailTab ?? "summary");
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const switchLogStream = () => {
    if (!selection) return;
    setLogPaused((paused) => !paused);
  };

  const toggleMaximize = async () => {
    if (!isRuntimeAvailable()) return;
    const currentWindow = getCurrentWindow();
    try {
      await currentWindow.toggleMaximize();
      setWindowMaximized(await currentWindow.isMaximized());
    } catch {
      // The window may be closing while its caption control is clicked.
    }
  };

  const beginDetailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    detailResize.current = { pointerId: event.pointerId };
    setDetailResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDetailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (detailResize.current?.pointerId !== event.pointerId || !event.currentTarget.parentElement) return;
    const bounds = event.currentTarget.parentElement.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    setDetailWidth(Math.max(360, Math.min(1050, bounds.right - event.clientX, bounds.width - 420)));
  };
  const endDetailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (detailResize.current?.pointerId === event.pointerId) {
      detailResize.current = null;
      setDetailResizing(false);
    }
  };
  const resizeDetailByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const bounds = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
      setDetailWidth((width) => Math.max(360, Math.min(1050, (bounds?.width ?? 1670) - 420, width + (event.key === "ArrowLeft" ? 24 : -24))));
    } else if (event.key === "Home") {
      event.preventDefault();
      setDetailWidth(480);
    }
  };

  const displayContext = contexts.find((item) => item.name === activeContext?.context);
  const visibleKinds: ResourceKind[] = section === "network" ? ["service", "ingress"] : section === "workloads" ? ["pod", "deployment", "statefulset"] : ["pod", "deployment"];
  const visibleListError = visibleKinds.map((kind) => listErrors[kind]).find(Boolean) ?? error;
  const currentWatchStatuses = watchedKinds.map((kind) => watchStatuses[kind]);
  const liveState = !windowVisible || currentWatchStatuses.some((status) => status === "stale" || status === "polling") ? "Stale" : currentWatchStatuses.every((status) => status === "live") ? "Live" : "Reconnecting";
  const allHealthy = loadState === "ready" && !visibleListError && liveState === "Live" && problemPods.length === 0 && unhealthyDeployments.length === 0;
  const liveIssue = watchedKinds.map((kind) => watchIssues[kind] ? `${kind}: ${watchIssues[kind]}` : null).filter(Boolean).join("\n");

  return (
    <main className="app-frame">
      <header className="app-titlebar" data-tauri-drag-region>
        <div className="titlebar-brand" data-tauri-drag-region>
          <span className="brand-mark" aria-hidden="true"><Activity size={15} strokeWidth={2.2} /></span>
          <span>Kubebs</span>
        </div>
        <div className="titlebar-breadcrumbs">
          <span>{section === "overview" ? "Overview" : section === "network" ? "Network" : section === "cluster" ? "Nodes" : "Workloads"}</span>
          {selection && <><ChevronRight size={14} /><span className="breadcrumb-current">{selection.name}</span></>}
        </div>
        <div className="titlebar-drag-space" data-tauri-drag-region onDoubleClick={() => void toggleMaximize()} />
        <div className="toolbar-actions titlebar-actions">
          <button className="icon-button" onClick={() => void openKubeconfig()} aria-label="Open kubeconfig file" title="Open kubeconfig file">
            <FolderOpen size={15} />
          </button>
          <NamespacePicker compact value={namespace} namespaces={namespaces} disabled={!activeContext} onChange={chooseNamespace} />
          {lastUpdated && <span className="updated-label">Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
          {activeContext && <span className={`watch-state watch-state-${liveState.toLowerCase()}`} title={liveIssue || `${liveState} resource updates`}><span />{liveState}</span>}
          <button className="icon-button" onClick={refresh} aria-label="Refresh workloads" title="Refresh">
            <RefreshCw size={15} className={loadState === "loading" && activeContext ? "spin" : ""} />
          </button>
        </div>
        {isRuntimeAvailable() && <div className="window-controls" aria-label="Window controls">
          <button aria-label="Minimize window" title="Minimize" onClick={() => void getCurrentWindow().minimize()}><Minus size={13} /></button>
          <button aria-label={windowMaximized ? "Restore window" : "Maximize window"} title={windowMaximized ? "Restore" : "Maximize"} onClick={() => void toggleMaximize()}>
            {windowMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button className="window-close" aria-label="Close window" title="Close" onClick={() => void getCurrentWindow().close()}><X size={14} /></button>
        </div>}
      </header>
      <div className="workspace">
        <aside className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed sidebar-compact" : ""}`}>
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <div className={`sidebar-context ${contextMenuOpen ? "context-menu-open" : ""}`} ref={contextMenu}>
            <button
              className="context-trigger"
              type="button"
              aria-label="Choose Kubernetes context or config file"
              title={activeContext?.context ?? "Choose Kubernetes context or config file"}
              aria-expanded={contextMenuOpen}
              onClick={() => setContextMenuOpen((open) => !open)}
            >
              <span className="context-avatar"><Cloud size={16} /></span>
              {sidebarContentVisible && (
                <span className="context-copy">
                  <span className="eyebrow">Active cluster</span>
                  <strong title={activeContext?.context ?? "No context selected"}>{activeContext?.context ?? "Not connected"}</strong>
                  <span className="context-server" title={displayContext?.server}>{displayContext?.cluster ?? "Local kubeconfig"}</span>
                </span>
              )}
              {sidebarContentVisible && <ChevronDown size={14} className="context-chevron" />}
            </button>
              <div className={`context-menu ${contextMenuOpen ? "menu-open" : ""}`} role="menu" aria-label="Kubernetes contexts" aria-hidden={!contextMenuOpen} inert={!contextMenuOpen}>
                {contexts.map((item) => (
                  <button
                    className={`context-option ${activeContext?.context === item.name ? "context-option-active" : ""}`}
                    type="button"
                    role="menuitem"
                    key={item.name}
                    title={item.name}
                    onClick={() => { setContextMenuOpen(false); void connect(item.name); }}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.cluster}{item.namespace ? ` · ${item.namespace}` : ""}</span>
                  </button>
                ))}
                <button
                  className="context-menu-file"
                  type="button"
                  role="menuitem"
                  onClick={() => { setContextMenuOpen(false); void openKubeconfig(); }}
                >
                  <FolderOpen size={14} /> Open kubeconfig file
                </button>
              </div>
          </div>

          {sidebarContentVisible && <div className="nav-heading">Workspace</div>}
          <nav className="primary-nav" aria-label="Main navigation">
            <button className={`nav-item ${section === "overview" ? "nav-item-active" : ""}`} onClick={() => setSection("overview")} title="Overview">
              <Activity size={16} /><span>Overview</span>
            </button>
            <button className={`nav-item ${section === "workloads" ? "nav-item-active" : ""}`} onClick={() => { setSection("workloads"); setKindFilter("all"); }} title="Workloads">
              <Layers3 size={16} /><span>Workloads</span>
              {sidebarContentVisible && <span className="nav-count">{pods.length + deployments.length + statefulSets.length}</span>}
            </button>
            <button className={`nav-item ${section === "network" ? "nav-item-active" : ""}`} onClick={() => { setSection("network"); setKindFilter("all"); }} title="Network">
              <Network size={16} /><span>Network</span>
              {sidebarContentVisible && <span className="nav-count">{services.length + ingresses.length}</span>}
            </button>
            <button className={`nav-item ${section === "cluster" ? "nav-item-active" : ""}`} onClick={() => setSection("cluster")} title="Nodes">
              <Server size={16} /><span>Nodes</span>{sidebarContentVisible && <span className="nav-count">{nodes.length}</span>}
            </button>
          </nav>

          {sidebarContentVisible && <div className="nav-heading nav-heading-spaced">Cluster</div>}
          <div className="namespace-control" title={`Namespace: ${namespace}`}>
            <Server size={15} />
            {sidebarContentVisible && <span>Namespace</span>}
            {sidebarContentVisible && <NamespacePicker value={namespace} namespaces={namespaces} disabled={!activeContext} onChange={chooseNamespace} />}
          </div>

          <div className="sidebar-bottom">
            <div className={`connection-indicator ${activeContext ? "connection-online" : "connection-offline"}`} title={activeContext ? liveState : "Disconnected"}>
              <span className="connection-dot" />
              {sidebarContentVisible && <span>{activeContext ? liveState : "Disconnected"}</span>}
            </div>
          </div>
        </aside>

        <section className="main-area">
          <div className={`content-and-detail ${panelOpen ? "detail-open" : ""} ${renderedSelection && !panelOpen ? "detail-closing" : ""} ${panelOpen && detailExpanded ? "detail-expanded" : ""} ${detailResizing ? "detail-resizing" : ""}`}>
            <div className="primary-content" inert={Boolean(panelOpen && detailExpanded)}>
              {!activeContext ? (
                <ConnectionScreen contexts={contexts} error={error} loading={loadState === "loading"} onOpenKubeconfig={() => void openKubeconfig()} onConnect={(name) => void connect(name)} />
              ) : section === "overview" ? (
                <Overview
                  context={activeContext}
                  namespace={namespace}
                  pods={pods}
                  deployments={deployments}
                  problemPods={problemPods}
                  unhealthyDeployments={unhealthyDeployments}
                  loadState={loadState}
                  error={visibleListError}
                  onResource={openResource}
                  onOpenWorkloads={() => setSection("workloads")}
                  onRetry={refresh}
                  allHealthy={allHealthy}
                  liveState={liveState}
                />
              ) : section === "cluster" ? <NodeView nodes={nodes} nodesError={nodesError} onRetryNodes={() => { setNodesLoading(true); void kubernetes.nodes().then((items) => { setNodes(items); setNodesError(null); }).catch((cause) => { setNodesError(errorFrom(cause)); }).finally(() => setNodesLoading(false)); }} nodeMetrics={nodeMetrics} podMetrics={podMetrics} namespace={namespace} nodeMetricsUnavailable={nodeMetricsUnavailable} podMetricsUnavailable={podMetricsUnavailable} loading={nodesLoading} /> : (
                <Workloads
                  key={section}
                  section={section}
                  pods={pods}
                  podMetrics={podMetrics}
                  metricsUnavailable={podMetricsUnavailable}
                  deployments={deployments}
                  statefulSets={statefulSets}
                  services={services}
                  ingresses={ingresses}
                  query={query}
                  onQuery={setQuery}
                  kindFilter={kindFilter}
                  onKindFilter={setKindFilter}
                  loadState={loadState}
                  error={visibleListError}
                  onRetry={refresh}
                  onResource={openResource}
                />
              )}
            </div>
            {renderedSelection && (
              <DetailPanel
                selection={renderedSelection}
                resourceTabs={resourceTabs}
                activeResourceKey={resourceKey(renderedSelection)}
                onSelectResourceTab={(resourceTab) => { setSelection(resourceTab.selection); setDetailTab(resourceTab.detailTab); }}
                onCloseResourceTab={(resourceTab) => {
                  const index = resourceTabs.findIndex((item) => item.key === resourceTab.key);
                  const next = resourceTabs.filter((item) => item.key !== resourceTab.key);
                  setResourceTabs(next);
                  if (resourceKey(renderedSelection) === resourceTab.key) {
                    const fallback = next[Math.min(index, next.length - 1)];
                    setSelection(fallback?.selection ?? null);
                    setDetailTab(fallback?.detailTab ?? "summary");
                  }
                }}
                tab={detailTab}
                setTab={selectDetailTab}
                state={detailState}
                error={detailError}
                pod={detailPod}
                deployment={detailDeployment}
                statefulSet={detailStatefulSet}
                service={detailService}
                ingress={detailIngress}
                relatedPods={relatedPods}
                logPodName={logPodName}
                setLogPodName={setLogPodName}
                events={events}
                eventsError={eventsError}
                yaml={yaml}
                yamlError={yamlError}
                relatedError={relatedError}
                logs={logs}
                logContainer={logContainer}
                setLogContainer={setLogContainer}
                logSearch={logSearch}
                setLogSearch={setLogSearch}
                showLogTimestamps={showLogTimestamps}
                setShowLogTimestamps={setShowLogTimestamps}
                paused={logPaused}
                logPane={logPane}
                copied={copied}
                rolloutRevisions={rolloutRevisions}
                rolloutError={rolloutError}
                rolloutBusy={rolloutBusy}
                onRestartDeployment={() => void restartDeployment()}
                onRestoreRevision={(revision) => void restoreRollout(revision)}
                shellSession={shellSession}
                shellError={shellError}
                onShellError={reportShellError}
                shellPod={shellPod}
                shellContainer={shellContainer}
                resourcePodMetrics={resourcePodMetrics}
                resourceMetricsUnavailable={resourceMetricsUnavailable}
                setShellPod={setShellPod}
                setShellContainer={setShellContainer}
                shellWriteRef={shellWriteRef}
                onStartShell={(podName, container, cols, rows) => {
                  if (podName && container) void startPodShell(podName, container, cols, rows);
                }}
                onCloseShell={() => { if (shellSession) void kubernetes.closeShell(shellSession); setShellSession(null); }}
                width={panelOpen ? detailWidth : 0}
                expanded={panelOpen && detailExpanded}
                closing={!panelOpen}
                onToggleExpanded={() => setDetailExpanded((value) => !value)}
                onResizeStart={beginDetailResize}
                onResizeMove={moveDetailResize}
                onResizeEnd={endDetailResize}
                onResizeKeyDown={resizeDetailByKeyboard}
                onClose={closeDetails}
                onResource={openResource}
                onCopy={copyText}
                onToggleLogs={switchLogStream}
              />
            )}
          </div>
        </section>
      </div>
      <dialog
        className="rollout-confirm-dialog"
        ref={rolloutDialog}
        aria-labelledby="rollout-confirm-title"
        onCancel={(event) => { event.preventDefault(); setRolloutConfirmation(null); }}
        onClose={() => setRolloutConfirmation(null)}
      >
        {rolloutConfirmation && selection && activeContext && <>
          <h2 id="rollout-confirm-title">{rolloutConfirmation.action === "restart" ? "Restart deployment rollout?" : `Restore revision ${rolloutConfirmation.revision}?`}</h2>
          <p>{rolloutConfirmation.action === "restart" ? "Kubernetes will restart the deployment's Pods." : "The deployment's Pod template will be changed to this retained revision."}</p>
          <dl>
            <div><dt>Cluster</dt><dd>{activeContext.context}</dd></div>
            <div><dt>Namespace</dt><dd>{selection.namespace}</dd></div>
            <div><dt>Deployment</dt><dd>{selection.name}</dd></div>
          </dl>
          <div className="rollout-confirm-actions">
            <button className="dialog-cancel" type="button" onClick={() => setRolloutConfirmation(null)}>Cancel</button>
            <button className="dialog-confirm" type="button" onClick={() => void confirmRolloutAction()}>
              {rolloutConfirmation.action === "restart" ? "Restart rollout" : "Restore revision"}
            </button>
          </div>
        </>}
      </dialog>
    </main>
  );
}

function ConnectionScreen({
  contexts,
  error,
  loading,
  onConnect,
  onOpenKubeconfig,
}: {
  contexts: KubernetesContext[];
  error: InfraError | null;
  loading: boolean;
  onConnect: (context: string) => void;
  onOpenKubeconfig: () => void;
}) {
  const [selected, setSelected] = useState(contexts.find((item) => item.isCurrent)?.name ?? contexts[0]?.name ?? "");
  const noContexts = contexts.length === 0;
  useEffect(() => {
    setSelected(contexts.find((item) => item.isCurrent)?.name ?? contexts[0]?.name ?? "");
  }, [contexts]);
  return (
    <div className="connection-page">
      <div className="connection-panel">
        <div className="connection-symbol">{error?.kind === "permission_denied" ? <AlertTriangle size={22} /> : <Cloud size={22} />}</div>
        <p className="eyebrow">Cluster connection</p>
        <h1>{loading ? contexts.length ? "Connecting to cluster" : "Loading kubeconfig" : noContexts ? "Open a kubeconfig file" : "Choose a context"}</h1>
        <p className="connection-description">
          {loading ? contexts.length ? `Connecting to ${selected}…` : "Reading kubeconfig…" : error?.message ?? (noContexts
            ? "Choose a kubeconfig file. Kubebs won't modify it; credentials stay on this device."
            : "Choose a context. Credentials stay on this device.")}
        </p>
        {!noContexts && <span className="field-label">Kubernetes context</span>}
        {!noContexts && <DropdownMenu
          className="connect-context-picker"
          ariaLabel="Kubernetes context"
          value={selected}
          options={contexts.map((item) => ({ value: item.name, label: item.name }))}
          onChange={setSelected}
        />}
        <button className="primary-button" disabled={loading} onClick={() => noContexts ? onOpenKubeconfig() : onConnect(selected)}>
          {loading ? "Connecting…" : noContexts ? "Open kubeconfig file" : "Connect to cluster"}
        </button>
        {!noContexts && <button className="open-another-config" onClick={onOpenKubeconfig}>Choose a different file</button>}
      </div>
    </div>
  );
}

function DropdownMenu({
  className = "",
  ariaLabel,
  value,
  options,
  onChange,
}: {
  className?: string;
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const selected = options.find((option) => option.value === value)?.label ?? value;
  const widestOption = Math.max(0, ...options.map((option) => option.label.length * 6 + 24));
  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const trigger = root.current?.querySelector<HTMLButtonElement>(".dropdown-menu-trigger");
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const contentWidth = Math.max(widestOption, bounds.width);
      const width = Math.min(className.includes("connect-context-picker") ? bounds.width : contentWidth, className.includes("connect-context-picker") ? window.innerWidth - 16 : 260, window.innerWidth - 16);
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
      const height = Math.min(options.length * 29 + 8, 320, window.innerHeight * 0.55);
      const preferredTop = bounds.bottom + height > window.innerHeight - 8 && bounds.top > height + 5 ? bounds.top - height - 5 : bounds.bottom + 5;
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8));
      setPosition({ left, top, width });
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [className, open, options.length, widestOption]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <>
    <div className={`dropdown-menu-picker ${className}`} ref={root}>
      <button
        type="button"
        className="dropdown-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selected}</span><ChevronDown size={13} />
      </button>
    </div>
    {createPortal(
        <div ref={menu} className={`dropdown-menu-options ${open && position ? "menu-open" : ""}`} role="listbox" aria-label={ariaLabel} aria-hidden={!open} inert={!open} style={{ left: position?.left ?? -10000, top: position?.top ?? -10000, width: position?.width ?? 0 }}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`dropdown-menu-option ${option.value === value ? "dropdown-menu-option-selected" : ""}`}
              key={option.value}
              title={option.label}
              onClick={() => { setOpen(false); onChange(option.value); }}
            >
              {option.label}
            </button>
          ))}
        </div>, document.body)}
  </>;
}

function NamespacePicker({
  value,
  namespaces,
  disabled,
  compact = false,
  onChange,
}: {
  value: string;
  namespaces: NamespaceInfo[];
  disabled: boolean;
  compact?: boolean;
  onChange: (namespace: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options = [{ name: "all", label: "All namespaces" }, ...namespaces.map((item) => ({ name: item.name, label: item.name }))];
  const current = options.find((item) => item.name === value)?.label ?? value;
  return (
    <div className={`namespace-picker ${compact ? "namespace-picker-compact" : ""}`} ref={root}>
      <button
        type="button"
        className="namespace-picker-button"
        aria-label={`Namespace: ${current}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current}</span><ChevronDown size={13} />
      </button>
        <div className={`namespace-menu ${open ? "menu-open" : ""}`} role="listbox" aria-label="Namespaces" aria-hidden={!open} inert={!open}>
          {options.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.name === value}
              className={`namespace-option ${item.name === value ? "namespace-option-selected" : ""}`}
              key={item.name}
              title={item.label}
              onClick={() => { setOpen(false); onChange(item.name); }}
            >
              {item.label}
            </button>
          ))}
        </div>
    </div>
  );
}

function Overview({
  context,
  namespace,
  pods,
  deployments,
  problemPods,
  unhealthyDeployments,
  loadState,
  error,
  onResource,
  onOpenWorkloads,
  onRetry,
  allHealthy,
  liveState,
}: {
  context: ConnectionInfo | null;
  namespace: string;
  pods: PodSummary[];
  deployments: DeploymentSummary[];
  problemPods: PodSummary[];
  unhealthyDeployments: DeploymentSummary[];
  loadState: LoadState;
  error: InfraError | null;
  onResource: (kind: Kind, name: string, namespace: string) => void;
  onOpenWorkloads: () => void;
  onRetry: () => void;
  allHealthy: boolean;
  liveState: string;
}) {
  const totalReadyPods = pods.reduce((count, pod) => count + pod.readyContainers, 0);
  const totalContainers = pods.reduce((count, pod) => count + pod.totalContainers, 0);
  const recentProblems = [
    ...problemPods.map((pod) => ({ kind: "pod" as const, name: pod.name, namespace: pod.namespace, status: pod.status, note: `${pod.restarts} restarts · ${pod.readyContainers}/${pod.totalContainers} containers ready`, age: pod.createdAt })),
    ...unhealthyDeployments.map((item) => ({ kind: "deployment" as const, name: item.name, namespace: item.namespace, status: "Rollout incomplete", note: `${item.ready}/${item.desired} replicas ready`, age: item.createdAt })),
  ].slice(0, 6);

  return (
    <div className="screen overview-screen">
      <div className="page-heading overview-heading">
        <div>
          <p className="eyebrow">Cluster overview</p>
          <h1>{context?.context ?? "Cluster"}</h1>
          <p className="page-subtitle">{namespace === "all" ? "All namespaces" : namespace} <span className="subtle-separator">/</span> {context?.server || "Kubernetes API"}</p>
        </div>
        <div className={`health-banner ${allHealthy ? "health-good" : "health-attention"}`}>
          {allHealthy ? <Check size={15} /> : <Activity size={15} />}
          <span>{loadState === "loading" ? "Checking workloads" : loadState === "error" || error ? "Workload status incomplete" : liveState === "Reconnecting" ? "Syncing updates" : liveState === "Stale" ? "Status may be outdated" : allHealthy ? "No workload issues" : `${problemPods.length + unhealthyDeployments.length} need attention`}</span>
        </div>
      </div>

      {error && <InlineError error={error} onRetry={onRetry} />}

      <div className="overview-columns">
        <section className="problem-section">
          <div className="section-heading">
            <div><h2>Needs attention</h2></div>
            <button className="text-button" onClick={onOpenWorkloads}>All workloads <ChevronRight size={14} /></button>
          </div>
          {loadState === "loading" ? <LoadingState label="Reading Pods and Deployments" compact /> : loadState === "error" ? null : recentProblems.length === 0 ? (
            <div className="quiet-empty"><span className="empty-check"><Check size={16} /></span><div><strong>No workload issues</strong></div></div>
          ) : (
            <div className="problem-list">
              {recentProblems.map((problem) => (
                <button className="problem-row" key={`${problem.kind}-${problem.namespace}-${problem.name}`} onClick={() => onResource(problem.kind, problem.name, problem.namespace)}>
                  <span className="problem-icon"><AlertTriangle size={15} /></span>
                  <span className="problem-main"><strong>{problem.name}</strong><span>{problem.note}</span></span>
                  <span className={`status-text status-${statusTone(problem.status)}`}>{problem.status}</span>
                  <span className="row-age">{formatAge(problem.age)}</span>
                  <ChevronRight size={14} className="row-chevron" />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="deployment-section">
          <div className="section-heading">
            <div><h2>Deployments</h2></div>
            <span className="section-count">{deployments.length}</span>
          </div>
          {loadState === "loading" ? <LoadingState label="Loading Deployments" compact /> : loadState === "error" ? null : deployments.length === 0 ? (
            <div className="small-empty">No Deployments</div>
          ) : (
            <div className="deployment-list">
              {deployments.slice(0, 7).map((deployment) => (
                <button key={`${deployment.namespace}-${deployment.name}`} className="deployment-row" onClick={() => onResource("deployment", deployment.name, deployment.namespace)}>
                  <span className={`resource-state ${deploymentHealthy(deployment) ? "resource-state-good" : "resource-state-bad"}`} />
                  <span className="deployment-name"><strong>{deployment.name}</strong><small>{deployment.namespace}</small></span>
                  <span className="replica-count">{deployment.ready}<span>/</span>{deployment.desired}</span>
                  <ChevronRight size={14} className="row-chevron" />
                </button>
              ))}
              {deployments.length > 7 && <button className="list-more" onClick={onOpenWorkloads}>Show {deployments.length - 7} more</button>}
            </div>
          )}
        </section>
      </div>

      <section className="health-strip" aria-label="Workload summary">
        <SummaryMetric label="Containers ready" value={loadState !== "ready" ? "—" : `${totalReadyPods}/${totalContainers}`} note={loadState === "ready" ? `${pods.length} Pods` : ""} tone={problemPods.length ? "warning" : "normal"} />
        <SummaryMetric label="Deployments ready" value={loadState !== "ready" ? "—" : `${deployments.filter(deploymentHealthy).length}/${deployments.length}`} note="" tone={unhealthyDeployments.length ? "warning" : "normal"} />
        <SummaryMetric label="Needs attention" value={loadState !== "ready" ? "—" : `${problemPods.length + unhealthyDeployments.length}`} note="" tone={problemPods.length + unhealthyDeployments.length ? "danger" : "normal"} />
      </section>
    </div>
  );
}

function SummaryMetric({ label, value, note, tone }: { label: string; value: string; note: string; tone: "normal" | "warning" | "danger" }) {
  return <div className={`summary-metric metric-${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong>{note && <span className="metric-note">{note}</span>}</div>;
}

function quantityValue(value: string | undefined, kind: "cpu" | "memory"): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]*)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (kind === "cpu") {
    const multiplier: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1 };
    return multiplier[unit] === undefined ? null : amount * multiplier[unit];
  }
  const multiplier: Record<string, number> = { "": 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, k: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 };
  return multiplier[unit] === undefined ? null : amount * multiplier[unit];
}

function formatResourceQuantity(value: string | undefined, kind: "cpu" | "memory"): string {
  const base = quantityValue(value, kind);
  return base === null ? "—" : formatBaseResourceQuantity(base, kind);
}

function formatBaseResourceQuantity(base: number, kind: "cpu" | "memory"): string {
  if (kind === "cpu") return base < 1 ? `${(base * 1000).toFixed(2)}m` : `${base.toFixed(2)} cores`;
  if (base >= 1024 ** 3) return `${(base / 1024 ** 3).toFixed(2)} GiB`;
  if (base >= 1024 ** 2) return `${(base / 1024 ** 2).toFixed(2)} MiB`;
  return `${(base / 1024).toFixed(2)} KiB`;
}

function formatCompactResourceQuantity(base: number, kind: "cpu" | "memory"): string {
  if (kind === "cpu") return base < 1 ? `${(base * 1000).toFixed(2)}m` : `${base.toFixed(2)}c`;
  if (base >= 1024 ** 3) return `${(base / 1024 ** 3).toFixed(2)}Gi`;
  if (base >= 1024 ** 2) return `${(base / 1024 ** 2).toFixed(2)}Mi`;
  return `${(base / 1024).toFixed(2)}Ki`;
}

type PodResourceTotals = { cpuRequest?: number; cpuLimit?: number; memoryRequest?: number; memoryLimit?: number };

function sumPresent(values: Array<string | undefined>, kind: "cpu" | "memory"): number | undefined {
  const parsed = values.map((value) => quantityValue(value, kind)).filter((value): value is number => value !== null);
  return parsed.length ? parsed.reduce((total, value) => total + value, 0) : undefined;
}

function podResourceTotals(pod: PodSummary): PodResourceTotals {
  const resources = pod.containers.map((container) => container.resources);
  return {
    cpuRequest: sumPresent(resources.map((item) => item.cpuRequest), "cpu"),
    cpuLimit: sumPresent(resources.map((item) => item.cpuLimit), "cpu"),
    memoryRequest: sumPresent(resources.map((item) => item.memoryRequest), "memory"),
    memoryLimit: sumPresent(resources.map((item) => item.memoryLimit), "memory"),
  };
}

function aggregatePodResources(pods: PodSummary[]): PodResourceTotals {
  const totals = pods.map(podResourceTotals);
  const sum = (key: keyof PodResourceTotals) => {
    const setValues = totals.map((item) => item[key]).filter((value): value is number => value !== undefined);
    return setValues.length ? setValues.reduce((total, value) => total + value, 0) : undefined;
  };
  return { cpuRequest: sum("cpuRequest"), cpuLimit: sum("cpuLimit"), memoryRequest: sum("memoryRequest"), memoryLimit: sum("memoryLimit") };
}

function metricBase(metric: ResourceMetric | undefined, kind: "cpu" | "memory"): number | undefined {
  const quantity = quantityValue(kind === "cpu" ? metric?.cpu : metric?.memory, kind);
  return quantity === null ? undefined : quantity;
}

type WorkloadUsage = { value: string; amount?: number; percent?: number; title: string };
type WorkloadSortColumn = "name" | "namespace" | "status" | "ready" | "cpu" | "memory" | "restarts" | "age" | "detail";
type WorkloadSortState = { column: WorkloadSortColumn; direction: "asc" | "desc" };
type SortableWorkloadRow = {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  detail: string;
  age?: string;
  restarts: string;
  cpuUsage: WorkloadUsage;
  memoryUsage: WorkloadUsage;
};

function workloadSortValue(row: SortableWorkloadRow, column: WorkloadSortColumn): number | string | undefined {
  switch (column) {
    case "name": return row.name;
    case "namespace": return row.namespace;
    case "status": return row.status;
    case "detail": return row.detail;
    case "cpu": return row.cpuUsage.amount;
    case "memory": return row.memoryUsage.amount;
    case "restarts": return row.restarts === "—" ? undefined : Number(row.restarts);
    case "age": {
      const timestamp = row.age ? Date.parse(row.age) : Number.NaN;
      return Number.isNaN(timestamp) ? undefined : timestamp;
    }
    case "ready": {
      const match = row.ready.match(/^(\d+)\/(\d+)$/);
      if (!match) return row.ready;
      const desired = Number(match[2]);
      return desired === 0 ? 1 : Number(match[1]) / desired;
    }
  }
}

function WorkloadSortHeader({ column, label, sort, onSort }: {
  column: WorkloadSortColumn;
  label: string;
  sort: WorkloadSortState;
  onSort: (column: WorkloadSortColumn) => void;
}) {
  const active = sort.column === column;
  return <th aria-sort={active ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
    <button className={`resource-sort-button ${active ? "resource-sort-active" : ""}`} onClick={() => onSort(column)}>
      {label}<span aria-hidden="true">{active ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</span>
    </button>
  </th>;
}

function workloadUsage(pods: PodSummary[], metrics: ResourceMetric[], unavailable: boolean, kind: "cpu" | "memory"): WorkloadUsage {
  if (!pods.length) return { value: "—", title: "No related Pods" };
  if (unavailable) return { value: "—", title: "Metrics unavailable" };
  const values = pods.map((pod) => metricBase(metrics.find((metric) => metric.name === pod.name && metric.namespace === pod.namespace), kind));
  const reported = values.filter((value): value is number => value !== undefined);
  if (!reported.length) return { value: "—", title: "Usage not reported" };

  const usage = reported.reduce((total, value) => total + value, 0);
  const resources = aggregatePodResources(pods);
  const request = kind === "cpu" ? resources.cpuRequest : resources.memoryRequest;
  const limit = kind === "cpu" ? resources.cpuLimit : resources.memoryLimit;
  const denominator = limit ?? request;
  const percent = values.every((value) => value !== undefined) && denominator && denominator > 0
    ? usage / denominator * 100
    : undefined;
  const unit = kind === "cpu" ? "CPU" : "Memory";
  const details = [
    `${unit} usage: ${formatCompactResourceQuantity(usage, kind)}`,
    request === undefined ? "Request not set" : `Request: ${formatCompactResourceQuantity(request, kind)}`,
    limit === undefined ? "Limit not set" : `Limit: ${formatCompactResourceQuantity(limit, kind)}`,
    percent === undefined ? (reported.length < pods.length ? "Metrics partial" : "No request or limit") : `${Number(percent.toFixed(2))}% of ${limit !== undefined ? "limit" : "request"}`,
  ];
  return { value: formatCompactResourceQuantity(usage, kind), amount: usage, percent, title: details.join(" · ") };
}

function NodeView({ nodes, nodesError, onRetryNodes, nodeMetrics, podMetrics, namespace, nodeMetricsUnavailable, podMetricsUnavailable, loading }: { nodes: NodeSummary[]; nodesError: InfraError | null; onRetryNodes: () => void; nodeMetrics: ResourceMetric[]; podMetrics: ResourceMetric[]; namespace: string; nodeMetricsUnavailable: boolean; podMetricsUnavailable: boolean; loading: boolean }) {
  const metricFor = (items: ResourceMetric[], name: string) => items.find((metric) => metric.name === name);
  const podRows = namespace === "all" ? podMetrics : podMetrics.filter((metric) => metric.namespace === namespace);
  const nodePressure = (node: NodeSummary) => node.conditions.filter((condition) => {
    const type = condition.conditionType;
    return (type === "Ready" && condition.status !== "True") || (["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"].includes(type) && condition.status === "True");
  });
  return <div className="screen node-screen">
    <div className="page-heading"><div><h1>Nodes</h1></div><span className="section-count">{nodes.length}</span></div>
    {nodesError && <InlineError error={nodesError} onRetry={onRetryNodes} />}
    {loading ? <LoadingState label="Loading cluster nodes" /> : !nodesError && nodes.length === 0 ? <EmptyState title="No nodes available" message="The cluster returned no Nodes in this context." /> : <div className="node-list">{nodes.map((node) => {
      const usage = metricFor(nodeMetrics, node.name);
      const cpuUsage = quantityValue(usage?.cpu, "cpu");
      const cpuCapacity = quantityValue(node.allocatableCpu, "cpu");
      const memoryUsage = quantityValue(usage?.memory, "memory");
      const memoryCapacity = quantityValue(node.allocatableMemory, "memory");
      const pressures = nodePressure(node);
      return <article className="node-card" key={node.name}>
        <div className="node-card-heading"><span className={`resource-state ${node.ready ? "resource-state-good" : "resource-state-bad"}`} /><div><strong>{node.name}</strong><span>{node.version || "Kubelet version unavailable"}</span></div><b className={`status-text status-${node.ready ? "good" : "bad"}`}>{node.ready ? "Ready" : "Not ready"}</b></div>
        <div className="node-capacity-list">
          <CapacityMeter label="CPU" usage={usage?.cpu} capacity={node.allocatableCpu} percent={cpuUsage !== null && cpuCapacity ? cpuUsage / cpuCapacity * 100 : null} unavailable={nodeMetricsUnavailable} kind="cpu" />
          <CapacityMeter label="Memory" usage={usage?.memory} capacity={node.allocatableMemory} percent={memoryUsage !== null && memoryCapacity ? memoryUsage / memoryCapacity * 100 : null} unavailable={nodeMetricsUnavailable} kind="memory" />
        </div>
        <details className="node-conditions"><summary>{pressures.length ? `${pressures.length} condition${pressures.length === 1 ? "" : "s"} need attention` : "Conditions"}</summary>
          {pressures.length ? <ul className="node-pressure-list">{pressures.map((condition) => <li key={condition.conditionType}><strong>{condition.conditionType}</strong><span>{condition.reason || condition.status}</span>{condition.message && <p>{condition.message}</p>}</li>)}</ul> : <ul className="node-condition-list">{node.conditions.map((condition) => <li key={condition.conditionType}><strong>{condition.conditionType}</strong><span>{condition.status === "True" ? "True" : condition.status === "False" ? "False" : condition.status}</span></li>)}</ul>}
        </details>
      </article>;
    })}</div>}
    <section className="node-pod-metrics"><div className="section-heading"><h2>Pod usage</h2></div>
    {podMetricsUnavailable ? <div className="small-empty">Metrics unavailable. Check Metrics Server or RBAC.</div> : podRows.length === 0 ? <div className="small-empty">No Pod metrics for this scope.</div> : <div className="pod-metric-table-wrap"><table className="pod-metric-table"><thead><tr><th>Pod</th><th>Namespace</th><th className="metric-cpu">CPU</th><th className="metric-memory">Memory</th></tr></thead><tbody>{podRows.map((metric) => <tr key={`${metric.namespace}/${metric.name}`}><td>{metric.name}</td><td>{metric.namespace}</td><td className="metric-cpu">{formatResourceQuantity(metric.cpu, "cpu")}</td><td className="metric-memory">{formatResourceQuantity(metric.memory, "memory")}</td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}

function CapacityMeter({ label, usage, capacity, percent, unavailable, kind }: { label: string; usage?: string; capacity?: string; percent: number | null; unavailable: boolean; kind: "cpu" | "memory" }) {
  const clamped = percent === null ? 0 : Math.max(0, Math.min(percent, 100));
  return <div className={`capacity-meter capacity-meter-${kind}`}>
    <div className="capacity-label"><span>{label}</span><strong>{unavailable ? "Metrics unavailable" : usage ? formatResourceQuantity(usage, kind) : "No usage data"}</strong></div>
    <div className="capacity-track" role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(clamped.toFixed(2))} aria-valuetext={percent === null || unavailable ? "Usage unavailable" : `${Number(percent.toFixed(2))} percent used`}><span style={{ width: `${clamped}%` }} /></div>
    <div className="capacity-foot"><span>{capacity ? `${formatResourceQuantity(capacity, kind)} allocatable` : "Allocatable capacity unavailable"}</span><span>{percent === null || unavailable ? "" : `${Number(percent.toFixed(2))}%`}</span></div>
  </div>;
}

function Workloads({
  section,
  pods,
  podMetrics,
  metricsUnavailable,
  deployments,
  statefulSets,
  services,
  ingresses,
  query,
  onQuery,
  kindFilter,
  onKindFilter,
  loadState,
  error,
  onRetry,
  onResource,
}: {
  section: "workloads" | "network";
  pods: PodSummary[];
  podMetrics: ResourceMetric[];
  metricsUnavailable: boolean;
  deployments: DeploymentSummary[];
  statefulSets: StatefulSetSummary[];
  services: ServiceSummary[];
  ingresses: IngressSummary[];
  query: string;
  onQuery: (value: string) => void;
  kindFilter: "all" | Kind;
  onKindFilter: (value: "all" | Kind) => void;
  loadState: LoadState;
  error: InfraError | null;
  onRetry: () => void;
  onResource: (kind: Kind, name: string, namespace: string) => void;
}) {
  const [sort, setSort] = useState<{ column: WorkloadSortColumn; direction: "asc" | "desc" }>({ column: "name", direction: "asc" });
  const resourceKinds: Kind[] = section === "network" ? ["service", "ingress"] : ["deployment", "statefulset"];
  const resourceOptions = [{ value: "all", label: "All resource types" }, ...resourceKinds.map((kind) => ({ value: kind, label: ({ deployment: "Deployments", statefulset: "StatefulSets", pod: "Pods", service: "Services", ingress: "Ingresses" } as const)[kind] }))];
  const normalized = query.trim().toLowerCase();
  const selectedPods = (selector: Record<string, string>, namespace: string) => Object.keys(selector).length ? pods.filter((pod) => pod.namespace === namespace && Object.entries(selector).every(([key, value]) => pod.labels[key] === value)) : [];
  const rows = [
    ...deployments.map((item) => {
      const matchedPods = selectedPods(item.selector, item.namespace);
      return { kind: "deployment" as const, name: item.name, namespace: item.namespace, status: deploymentHealthy(item) ? "Available" : "Progressing", ready: `${item.ready}/${item.desired}`, detail: item.image ?? "", age: item.createdAt, restarts: "—", cpuUsage: workloadUsage(matchedPods, podMetrics, metricsUnavailable, "cpu"), memoryUsage: workloadUsage(matchedPods, podMetrics, metricsUnavailable, "memory") };
    }),
    ...statefulSets.map((item) => {
      const matchedPods = selectedPods(item.selector, item.namespace);
      return { kind: "statefulset" as const, name: item.name, namespace: item.namespace, status: item.ready >= item.desired ? "Ready" : "Progressing", ready: `${item.ready}/${item.desired}`, detail: item.image ?? "", age: item.createdAt, restarts: "—", cpuUsage: workloadUsage(matchedPods, podMetrics, metricsUnavailable, "cpu"), memoryUsage: workloadUsage(matchedPods, podMetrics, metricsUnavailable, "memory") };
    }),
    ...pods.map((item) => ({ kind: "pod" as const, name: item.name, namespace: item.namespace, status: item.status, ready: `${item.readyContainers}/${item.totalContainers}`, detail: item.node ?? "", age: item.createdAt, restarts: `${item.restarts}`, cpuUsage: workloadUsage([item], podMetrics, metricsUnavailable, "cpu"), memoryUsage: workloadUsage([item], podMetrics, metricsUnavailable, "memory") })),
    ...services.map((item) => ({ kind: "service" as const, name: item.name, namespace: item.namespace, status: item.serviceType, ready: [item.clusterIp, ...item.externalIps].filter(Boolean).join(" · ") || "—", detail: item.ports.join(", "), age: item.createdAt, restarts: "—", cpuUsage: workloadUsage([], podMetrics, metricsUnavailable, "cpu"), memoryUsage: workloadUsage([], podMetrics, metricsUnavailable, "memory") })),
    ...ingresses.map((item) => ({ kind: "ingress" as const, name: item.name, namespace: item.namespace, status: item.addresses.length ? "Address assigned" : "No address", ready: item.addresses.join(", ") || "—", detail: item.hosts.join(", ") || "No host", age: item.createdAt, restarts: "—", cpuUsage: workloadUsage([], podMetrics, metricsUnavailable, "cpu"), memoryUsage: workloadUsage([], podMetrics, metricsUnavailable, "memory") })),
  ].filter((row) => resourceKinds.includes(row.kind) && (section !== "network" || kindFilter === "all" || row.kind === kindFilter) && (!normalized || `${row.name} ${row.namespace} ${row.status} ${row.detail}`.toLowerCase().includes(normalized)));
  const sortedRows = [...rows].sort((left, right) => {
    const a = workloadSortValue(left, sort.column);
    const b = workloadSortValue(right, sort.column);
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const comparison = typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    return comparison * (sort.direction === "asc" ? 1 : -1);
  });
  const toggleSort = (column: WorkloadSortColumn) => setSort((current) => ({
    column,
    direction: current.column === column && current.direction === "asc" ? "desc" : "asc",
  }));
  const hasFilter = Boolean(normalized) || (section === "network" && kindFilter !== "all");
  const resourceTitle = section === "network" ? "Network" : "Workloads";
  return (
    <div className={`screen workloads-screen ${section === "network" ? "network-screen" : ""}`}>
      <div className="page-heading">
        <div><h1>{resourceTitle}</h1></div>
      </div>
      <div className="list-toolbar">
        <label className="search-box"><Search size={15} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Filter resources" aria-label={`Filter ${resourceTitle.toLowerCase()}`} />{query && <button onClick={() => onQuery("")} aria-label="Clear search"><X size={13} /></button>}</label>
        {section === "network" && <div className="filter-select"><ListFilter size={14} /><DropdownMenu
          className="resource-kind-picker"
          ariaLabel={`${resourceTitle} type`}
          value={kindFilter}
          options={resourceOptions}
          onChange={(value) => onKindFilter(value as "all" | Kind)}
        /></div>}
      </div>
      {error && <InlineError error={error} onRetry={onRetry} />}
      {loadState === "loading" ? <LoadingState label={`Loading ${resourceTitle.toLowerCase()}`} /> : loadState === "error" ? null : rows.length === 0 ? (
        <EmptyState title={hasFilter ? "No matches" : `No ${resourceTitle.toLowerCase()}`} message={hasFilter ? "Clear the filter or try another name." : "Nothing in this namespace scope."} />
      ) : (
        <div className="resource-table-wrap">
          <table className="resource-table">
            <thead><tr>
              <WorkloadSortHeader column="name" label="NAME" sort={sort} onSort={toggleSort} />
              <WorkloadSortHeader column="namespace" label="NAMESPACE" sort={sort} onSort={toggleSort} />
              <WorkloadSortHeader column="status" label="STATUS" sort={sort} onSort={toggleSort} />
              <WorkloadSortHeader column="ready" label={section === "network" ? "ADDRESS" : "READY"} sort={sort} onSort={toggleSort} />
              {section === "network" ? <WorkloadSortHeader column="detail" label="PORTS / HOSTS" sort={sort} onSort={toggleSort} /> : <>
                <WorkloadSortHeader column="cpu" label="CPU Usage" sort={sort} onSort={toggleSort} />
                <WorkloadSortHeader column="memory" label="Mem Usage" sort={sort} onSort={toggleSort} />
                <WorkloadSortHeader column="restarts" label="RESTARTS" sort={sort} onSort={toggleSort} />
              </>}
              <WorkloadSortHeader column="age" label="AGE" sort={sort} onSort={toggleSort} />
            </tr></thead>
            <tbody>
              {sortedRows.map((row) => {
                const tone = row.kind === "pod" ? statusTone(row.status) : ["Available", "Ready", "ClusterIP", "NodePort", "LoadBalancer", "ExternalName", "Address assigned"].includes(row.status) ? "good" : "muted";
                const icon = row.kind === "pod" ? <TerminalSquare size={14} className="table-kind-icon" /> : row.kind === "service" || row.kind === "ingress" ? <Network size={14} className="table-kind-icon" /> : <Layers3 size={14} className="table-kind-icon" />;
                const kindLabel = resourceOptions.find((item) => item.value === row.kind)?.label.replace(/s$/, "") ?? row.kind;
                return <tr key={`${row.kind}-${row.namespace}-${row.name}`} onClick={() => onResource(row.kind, row.name, row.namespace)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && onResource(row.kind, row.name, row.namespace)}>
                  <td><span className={`resource-state ${tone === "good" ? "resource-state-good" : tone === "bad" ? "resource-state-bad" : "resource-state-muted"}`} />{icon}<strong>{row.name}</strong><span className="kind-label">{kindLabel}</span></td>
                  <td>{row.namespace}</td><td><StatusPill tone={tone} label={row.status} /></td>
                  <td className="table-ready" title={row.detail}>{row.ready}</td>{section === "network" ? <td className="table-muted" title={row.detail}>{row.detail || "—"}</td> : <><td className="table-usage"><WorkloadUsageCell kind="cpu" usage={row.cpuUsage} /></td><td className="table-usage"><WorkloadUsageCell kind="memory" usage={row.memoryUsage} /></td><td className={row.restarts !== "—" && Number(row.restarts) > 0 ? "restart-count" : "table-muted"}>{row.restarts}</td></>}<td className="table-muted">{formatAge(row.age)}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({ tone, label }: { tone: "good" | "bad" | "muted"; label: string }) {
  return <span className={`status-pill status-pill-${tone}`}><span />{label}</span>;
}

function WorkloadUsageCell({ kind, usage }: { kind: "cpu" | "memory"; usage: WorkloadUsage }) {
  const label = kind === "cpu" ? "CPU" : "Memory";
  const height = usage.percent === undefined ? 0 : Math.max(0, Math.min(usage.percent, 100));
  return <span className={`workload-usage-cell workload-usage-${kind}`} title={usage.title} aria-label={`${label}: ${usage.title}`}>
    <span className="workload-usage-meter" aria-hidden="true"><i style={{ height: `${height}%` }} /></span>
    <strong>{usage.value}</strong>
  </span>;
}

function DetailPanel({
  selection,
  resourceTabs,
  activeResourceKey,
  onSelectResourceTab,
  onCloseResourceTab,
  tab,
  setTab,
  state,
  error,
  pod,
  deployment,
  statefulSet,
  service,
  ingress,
  relatedPods,
  logPodName,
  setLogPodName,
  events,
  eventsError,
  yaml,
  yamlError,
  relatedError,
  logs,
  logContainer,
  setLogContainer,
  logSearch,
  setLogSearch,
  showLogTimestamps,
  setShowLogTimestamps,
  paused,
  logPane,
  copied,
  rolloutRevisions,
  rolloutError,
  rolloutBusy,
  onRestartDeployment,
  onRestoreRevision,
  shellSession,
  shellError,
  onShellError,
  shellPod,
  shellContainer,
  setShellPod,
  setShellContainer,
  shellWriteRef,
  onStartShell,
  onCloseShell,
  resourcePodMetrics,
  resourceMetricsUnavailable,
  onClose,
  onResource,
  onCopy,
  onToggleLogs,
  width,
  expanded,
  closing,
  onToggleExpanded,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
}: {
  selection: Selection;
  resourceTabs: ResourceTab[];
  activeResourceKey: string;
  onSelectResourceTab: (tab: ResourceTab) => void;
  onCloseResourceTab: (tab: ResourceTab) => void;
  tab: DetailTab;
  setTab: (tab: DetailTab) => void;
  state: LoadState;
  error: InfraError | null;
  pod: PodSummary | null;
  deployment: DeploymentSummary | null;
  statefulSet: StatefulSetSummary | null;
  service: ServiceSummary | null;
  ingress: IngressSummary | null;
  relatedPods: PodSummary[];
  logPodName: string;
  setLogPodName: (name: string) => void;
  events: EventSummary[];
  eventsError: InfraError | null;
  yaml: string;
  yamlError: InfraError | null;
  relatedError: InfraError | null;
  logs: string[];
  logContainer: string;
  setLogContainer: (container: string) => void;
  logSearch: string;
  setLogSearch: (query: string) => void;
  showLogTimestamps: boolean;
  setShowLogTimestamps: Dispatch<SetStateAction<boolean>>;
  paused: boolean;
  logPane: RefObject<HTMLDivElement | null>;
  copied: boolean;
  rolloutRevisions: RolloutRevision[];
  rolloutError: InfraError | null;
  rolloutBusy: boolean;
  onRestartDeployment: () => void;
  onRestoreRevision: (revision: number) => void;
  shellSession: string | null;
  shellError: InfraError | null;
  onShellError: (cause: unknown) => void;
  shellPod: string;
  shellContainer: string;
  setShellPod: (value: string) => void;
  setShellContainer: (value: string) => void;
  shellWriteRef: RefObject<((text: string) => void) | null>;
  onStartShell: (podName: string, container: string, cols: number, rows: number) => void;
  onCloseShell: () => void;
  resourcePodMetrics: ResourceMetric[];
  resourceMetricsUnavailable: boolean;
  onClose: () => void;
  onResource: (kind: Kind, name: string, namespace: string) => void;
  onCopy: (text: string) => void;
  onToggleLogs: () => void;
  width: number;
  expanded: boolean;
  closing: boolean;
  onToggleExpanded: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const hasWorkloadPods = selection.kind === "deployment" || selection.kind === "statefulset" || selection.kind === "service";
  const hasLogs = selection.kind === "pod" || selection.kind === "deployment" || selection.kind === "statefulset";
  const hasShell = selection.kind === "pod" || selection.kind === "deployment";
  const tabList: DetailTab[] = selection.kind === "pod" ? ["summary", "events", "logs", "shell", "yaml"] : ["summary", ...(hasWorkloadPods ? ["pods" as const] : []), ...(hasLogs ? ["logs" as const] : []), ...(hasShell ? ["shell" as const] : []), "events", "yaml"];
  const detailName = pod?.name ?? deployment?.name ?? statefulSet?.name ?? service?.name ?? ingress?.name ?? selection.name;
  const detailStatus = pod?.status ?? (deployment ? deploymentHealthy(deployment) ? "Available" : "Progressing" : statefulSet ? statefulSet.ready >= statefulSet.desired ? "Ready" : "Progressing" : service?.serviceType ?? (ingress ? ingress.addresses.length ? "Address assigned" : "No address" : "Loading"));
  const statusClass = pod ? statusTone(pod.status) : deployment ? deploymentHealthy(deployment) ? "good" : "bad" : statefulSet ? statefulSet.ready >= statefulSet.desired ? "good" : "bad" : service || (ingress?.addresses.length ?? 0) > 0 ? "good" : "muted";
  const count = events.length;
  const currentImages = deployment?.images?.length ? deployment.images : deployment?.image ? [deployment.image] : [];
  const visibleRevisions = [...rolloutRevisions]
    .filter((revision) => !revisionUsesCurrentImages(revision, currentImages))
    .reverse();
  const podMetric = selection.kind === "pod" ? resourcePodMetrics.find((metric) => metric.name === selection.name && metric.namespace === selection.namespace) : undefined;
  const podMetricRows = relatedPods.map((item) => ({ pod: item, metric: resourcePodMetrics.find((metric) => metric.name === item.name && metric.namespace === item.namespace), resources: podResourceTotals(item) }));
  const sumPodMetric = (kind: "cpu" | "memory") => {
    const values = podMetricRows.map(({ metric }) => metricBase(metric, kind)).filter((value): value is number => value !== undefined);
    return { value: values.length ? values.reduce((total, value) => total + value, 0) : undefined, reported: values.length };
  };
  const aggregateCpu = sumPodMetric("cpu");
  const aggregateMemory = sumPodMetric("memory");
  const deploymentUsage = {
    cpu: aggregateCpu.value,
    memory: aggregateMemory.value,
  };
  const deploymentResources = aggregatePodResources(relatedPods);
  const podResources = pod ? podResourceTotals(pod) : {};
  return (
    <aside className={`detail-panel ${expanded ? "detail-panel-expanded" : ""}`} style={{ width: expanded ? "100%" : `${width}px` }} aria-label={`${selection.kind} details`} aria-hidden={closing} inert={closing}>
      {!expanded && <div
        className="detail-resize-handle"
        role="separator"
        aria-label="Resize details panel"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={1050}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKeyDown}
      />}
      {resourceTabs.length > 0 && <div className="resource-tab-strip detail-resource-tabs" role="tablist" aria-label="Open resources">
        {resourceTabs.map((resourceTab) => <div className={`resource-tab ${resourceTab.key === activeResourceKey ? "resource-tab-active" : ""}`} key={resourceTab.key}>
          <button role="tab" aria-selected={resourceTab.key === activeResourceKey} onClick={() => onSelectResourceTab(resourceTab)} title={`${resourceTab.selection.kind} ${resourceTab.selection.namespace}/${resourceTab.selection.name}`}>
            <span>{resourceTab.selection.kind}</span><strong>{resourceTab.selection.name}</strong>
          </button>
          <button className="resource-tab-close" aria-label={`Close ${resourceTab.selection.name}`} onClick={() => onCloseResourceTab(resourceTab)}><X size={12} /></button>
        </div>)}
      </div>}
      <div className="detail-heading">
        <div className="detail-heading-main">
          <div className="detail-icon">{selection.kind === "pod" ? <TerminalSquare size={16} /> : selection.kind === "service" || selection.kind === "ingress" ? <Network size={16} /> : <Layers3 size={16} />}</div>
          <div className="detail-title-wrap"><span className="detail-kind">{selection.kind}</span><h2 title={detailName}>{detailName}</h2></div>
        </div>
        <div className="detail-heading-actions">
          <button className="icon-button" onClick={onToggleExpanded} aria-label={expanded ? "Restore details width" : "Expand details"} title={expanded ? "Restore details width" : "Expand details"}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button className="icon-button" onClick={onClose} aria-label="Close details"><X size={16} /></button>
        </div>
      </div>
      <div className="detail-meta"><span>{selection.namespace}</span><span className={`detail-status detail-status-${statusClass}`}><span />{detailStatus}</span></div>
      <div className="detail-tabs" role="tablist" aria-label="Resource details">
        {tabList.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "detail-tab selected" : "detail-tab"} onClick={() => setTab(item)}>{item === "pods" ? `Pods${state === "ready" && selection.kind === "deployment" ? ` ${relatedPods.length}` : ""}` : item === "events" ? `Events${state === "ready" ? ` ${count}` : ""}` : item === "yaml" ? "YAML" : item === "logs" ? "Logs" : item === "shell" ? "Shell" : "Overview"}</button>)}
      </div>
      <div key={`${selection.kind}/${selection.namespace}/${selection.name}/${tab}`} className={`detail-content ${tab === "logs" ? "detail-content-logs" : ""}`}>
        {state === "loading" ? <LoadingState label={`Loading ${selection.kind} details`} /> : state === "error" ? <InlineError error={error} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} /> : (
          <>
            {tab === "summary" && (
              <div className="detail-summary">
                {pod && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Activity size={15} /></span><div><strong>{pod.status}</strong><span>{pod.readyContainers} of {pod.totalContainers} containers ready</span></div></div>
                  <div className="detail-properties">
                    <Property label="Namespace" value={pod.namespace} />
                    <Property label="Node" value={pod.node ?? "Not scheduled"} />
                    <Property label="Restarts" value={`${pod.restarts}`} tone={pod.restarts ? "warning" : undefined} />
                    <Property label="Created" value={formatAge(pod.createdAt)} />
                  </div>
                  <ResourceUtilization
                    heading="Utilization"
                    usage={{ cpu: metricBase(podMetric, "cpu"), memory: metricBase(podMetric, "memory") }}
                    resources={podResources}
                    unavailable={resourceMetricsUnavailable}
                  />
                  <div className="detail-subheading"><h3>Containers</h3></div>
                  <div className="container-list">{pod.containers.map((container) => <div className="container-item" key={container.name}><span className={`container-ready ${container.ready ? "is-ready" : ""}`} /><div><strong>{container.name}</strong><code>{container.image}</code>{container.stateReason && <span className="container-reason">{container.stateReason}</span>}</div><span className="container-restarts">{container.restartCount} restarts</span></div>)}</div>
                </>}
                {deployment && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Activity size={15} /></span><div><strong>{deploymentHealthy(deployment) ? "Available" : "Rollout in progress"}</strong><span>{deployment.ready} of {deployment.desired} replicas ready</span></div></div>
                  <div className="replica-track"><span style={{ width: `${deployment.desired ? Math.min(100, (deployment.ready / deployment.desired) * 100) : 0}%` }} /></div>
                  <div className="detail-properties">
                    <Property label="Namespace" value={deployment.namespace} />
                    <Property label="Available" value={`${deployment.available}`} />
                    <Property label="Updated" value={`${deployment.updated}`} />
                    <Property label="Created" value={formatAge(deployment.createdAt)} />
                  </div>
                  <div className="deployment-utilization-heading"><h3>All related Pods</h3></div>
                  {relatedPods.length ? <>
                    <ResourceUtilization
                      heading=""
                      usage={deploymentUsage}
                      resources={deploymentResources}
                      coverage={{ cpu: aggregateCpu.reported, memory: aggregateMemory.reported, total: relatedPods.length }}
                      unavailable={resourceMetricsUnavailable}
                    />
                    <div className="workload-usage-list">{podMetricRows.map(({ pod: item, metric, resources }) => <article className="workload-usage-row" key={item.name}>
                      <div className="workload-usage-pod"><strong title={item.name}>{item.name}</strong><span>{item.status}</span></div>
                      <PodUsageLine metric={metric} resources={resources} unavailable={resourceMetricsUnavailable} />
                    </article>)}</div>
                  </> : <div className="usage-unavailable">No matching Pods.</div>}
                  <div className="detail-subheading"><h3>Container image</h3></div>
                  <code className="image-value">{deployment.image ?? "No image reported"}</code>
                  <button className="inline-link" onClick={() => setTab("pods")}>View Pods <ChevronRight size={14} /></button>
                  <div className="rollout-actions"><button className="small-action" disabled={rolloutBusy} onClick={onRestartDeployment}><RefreshCw size={12} /> Restart rollout</button></div>
                  <div className="detail-subheading"><h3>Revision history</h3><span>{visibleRevisions.length}</span></div>
                  {rolloutError ? <div className="rollout-error">{rolloutError.message}</div> : visibleRevisions.length ? <div className="revision-list">{visibleRevisions.map((item) => <div className="revision-row" key={item.revision}><div><strong>Revision {item.revision}</strong>{item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? <time dateTime={item.createdAt}>{new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(item.createdAt))}</time> : <span>Time unavailable</span>}<span>{item.images.join(", ") || "No image"}</span></div><button className="small-action" disabled={rolloutBusy} onClick={() => onRestoreRevision(item.revision)}>Restore</button></div>)}</div> : <div className="rollout-error">{rolloutRevisions.length ? "No retained revisions with a different image." : "No retained revisions."}</div>}
                </>}
                {statefulSet && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Activity size={15} /></span><div><strong>{statefulSet.ready >= statefulSet.desired ? "Ready" : "Rollout in progress"}</strong><span>{statefulSet.ready} of {statefulSet.desired} replicas ready</span></div></div>
                  <div className="replica-track"><span style={{ width: `${statefulSet.desired ? Math.min(100, (statefulSet.ready / statefulSet.desired) * 100) : 0}%` }} /></div>
                  <div className="detail-properties"><Property label="Namespace" value={statefulSet.namespace} /><Property label="Current" value={`${statefulSet.current}`} /><Property label="Updated" value={`${statefulSet.updated}`} /><Property label="Created" value={formatAge(statefulSet.createdAt)} /></div>
                  <div className="detail-subheading"><h3>Container image</h3></div><code className="image-value">{statefulSet.image ?? "No image reported"}</code>
                  <button className="inline-link" onClick={() => setTab("pods")}>View Pods <ChevronRight size={14} /></button>
                </>}
                {service && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Network size={15} /></span><div><strong>{service.serviceType}</strong><span>{service.clusterIp ? `Cluster IP ${service.clusterIp}` : "No cluster IP assigned"}</span></div></div>
                  <div className="detail-properties"><Property label="Namespace" value={service.namespace} /><Property label="Cluster IP" value={service.clusterIp ?? "None"} /><Property label="External IPs" value={service.externalIps.join(", ") || "None"} /><Property label="Created" value={formatAge(service.createdAt)} /></div>
                  <div className="detail-subheading"><h3>Ports</h3><span>{service.ports.length}</span></div>
                  <div className="detail-value-list">{service.ports.length ? service.ports.map((port) => <code key={port}>{port}</code>) : <span>No ports declared</span>}</div>
                  <button className="inline-link" onClick={() => setTab("pods")}>View Pods <ChevronRight size={14} /></button>
                </>}
                {ingress && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Network size={15} /></span><div><strong>{ingress.addresses.length ? "Address assigned" : "No address"}</strong>{ingress.addresses.length > 0 && <span>{ingress.addresses.join(", ")}</span>}</div></div>
                  <div className="detail-properties"><Property label="Namespace" value={ingress.namespace} /><Property label="Hosts" value={ingress.hosts.join(", ") || "All hosts"} /><Property label="Created" value={formatAge(ingress.createdAt)} /></div>
                  <div className="detail-subheading"><h3>Routes</h3><span>{ingress.rules.length}</span></div>
                  <div className="detail-value-list">{ingress.rules.length ? ingress.rules.map((rule) => <code key={rule}>{rule}</code>) : <span>No HTTP routes declared</span>}</div>
                </>}
              </div>
            )}
            {tab === "pods" && <RelatedPods pods={relatedPods} error={relatedError} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} onResource={onResource} />}
            {tab === "events" && <EventList events={events} error={eventsError} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} />}
            {tab === "yaml" && (yamlError ? <div className="partial-error"><InlineError error={yamlError} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} /></div> : <YamlView yaml={yaml} copied={copied} onCopy={onCopy} />)}
            {tab === "logs" && hasLogs && <LogsView key={`${selection.kind}/${selection.namespace}/${selection.name}`} selection={selection} pod={pod} relatedPods={relatedPods} logPodName={logPodName} setLogPodName={setLogPodName} logContainer={logContainer} setLogContainer={setLogContainer} logs={logs} logSearch={logSearch} setLogSearch={setLogSearch} showLogTimestamps={showLogTimestamps} setShowLogTimestamps={setShowLogTimestamps} paused={paused} logPane={logPane} error={error} onToggleLogs={onToggleLogs} />}
            {tab === "shell" && hasShell && <ShellTerminal
              selection={selection}
              relatedPods={relatedPods}
              pod={pod}
              sessionId={shellSession}
              error={shellError}
              onError={onShellError}
              selectedPod={shellPod}
              selectedContainer={shellContainer}
              setSelectedPod={(name) => { setShellPod(name); setShellContainer(""); }}
              setSelectedContainer={setShellContainer}
              writeRef={shellWriteRef}
              onConnect={onStartShell}
              onDisconnect={onCloseShell}
            />}
          </>
        )}
      </div>
    </aside>
  );
}

function ResourceUtilization({ heading, usage, resources, unavailable, coverage }: {
  heading: string;
  usage: { cpu?: number; memory?: number };
  resources: PodResourceTotals;
  unavailable: boolean;
  coverage?: { cpu: number; memory: number; total: number };
}) {
  return <section className="resource-utilization">
    {heading && <div className="resource-utilization-heading"><strong>{heading}</strong></div>}
    <div className="resource-utilization-grid">
      <ResourceGauge label="CPU" kind="cpu" usage={usage.cpu} request={resources.cpuRequest} limit={resources.cpuLimit} unavailable={unavailable} coverage={coverage ? { reported: coverage.cpu, total: coverage.total } : undefined} />
      <ResourceGauge label="Memory" kind="memory" usage={usage.memory} request={resources.memoryRequest} limit={resources.memoryLimit} unavailable={unavailable} coverage={coverage ? { reported: coverage.memory, total: coverage.total } : undefined} />
    </div>
  </section>;
}

function ResourceGauge({ label, kind, usage, request, limit, unavailable, coverage }: {
  label: string;
  kind: "cpu" | "memory";
  usage?: number;
  request?: number;
  limit?: number;
  unavailable: boolean;
  coverage?: { reported: number; total: number };
}) {
  const threshold = limit ?? request;
  const coverageComplete = !coverage || coverage.reported === coverage.total;
  const percent = coverageComplete && usage !== undefined && threshold !== undefined && threshold > 0 ? usage / threshold * 100 : undefined;
  const fillPercent = percent === undefined ? 0 : Math.max(0, Math.min(percent, 100));
  const overLimit = limit !== undefined && percent !== undefined && percent > 100;
  const overRequest = limit === undefined && request !== undefined && percent !== undefined && percent > 100;
  const percentage = percent === undefined ? "—" : `${Number(percent.toFixed(2))}%`;
  const denominator = !coverageComplete ? "incomplete metric coverage" : limit !== undefined ? "of limit" : request !== undefined ? "of request" : "no request or limit";
  const usageValue = unavailable ? "Unavailable" : usage === undefined ? "Not reported" : formatBaseResourceQuantity(usage, kind);
  const requestValue = request === undefined ? "Not set" : formatBaseResourceQuantity(request, kind);
  const limitValue = limit === undefined ? "Not set" : formatBaseResourceQuantity(limit, kind);
  return <div className={`resource-gauge resource-gauge-${kind} ${overLimit ? "resource-gauge-over-limit" : overRequest ? "resource-gauge-over-request" : ""}`}>
    <div className="resource-gauge-heading"><span>{label} %</span><strong>{percentage}</strong></div>
    <div className="resource-gauge-track" role="meter" aria-label={`${label} usage ${denominator}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fillPercent)} aria-valuetext={percent === undefined ? `Usage unavailable or ${denominator}` : `${percentage} ${denominator}`}><span style={{ width: `${fillPercent}%` }} /></div>
    {!coverageComplete && !unavailable ? <span className="resource-gauge-denominator">Partial usage</span> : coverageComplete && threshold !== undefined && <span className="resource-gauge-denominator">{denominator}</span>}
    <dl className="resource-gauge-values">
      <div><dt>Usage</dt><dd>{usageValue}</dd></div>
      {request !== undefined && <div><dt>Requested</dt><dd>{requestValue}</dd></div>}
      {limit !== undefined && <div><dt>Limit</dt><dd>{limitValue}</dd></div>}
      {request === undefined && limit === undefined && <div><dt>Request / limit</dt><dd>Not set</dd></div>}
    </dl>
  </div>;
}

function PodUsageLine({ metric, resources, unavailable }: { metric?: ResourceMetric; resources: PodResourceTotals; unavailable: boolean }) {
  const value = (label: string, kind: "cpu" | "memory") => {
    const usage = metricBase(metric, kind);
    const request = kind === "cpu" ? resources.cpuRequest : resources.memoryRequest;
    const limit = kind === "cpu" ? resources.cpuLimit : resources.memoryLimit;
    const baseline = limit ?? request;
    const percent = usage !== undefined && baseline !== undefined && baseline > 0 ? `${Number((usage / baseline * 100).toFixed(2))}% ${limit !== undefined ? "limit" : "request"}` : "";
    const text = unavailable ? "unavailable" : usage === undefined ? "—" : `${formatCompactResourceQuantity(usage, kind)}${percent ? ` (${percent})` : ""}`;
    const title = `Usage ${text}, requested ${request === undefined ? "not set" : formatBaseResourceQuantity(request, kind)}, limit ${limit === undefined ? "not set" : formatBaseResourceQuantity(limit, kind)}`;
    return <span title={title}><b>{label}</b> {text}</span>;
  };
  return <div className="pod-usage-line">{value("CPU", "cpu")}<i>·</i>{value("Mem", "memory")}</div>;
}

function ShellTerminal({ selection, relatedPods, pod, sessionId, error, onError, selectedPod, selectedContainer, setSelectedPod, setSelectedContainer, writeRef, onConnect, onDisconnect }: {
  selection: Selection;
  relatedPods: PodSummary[];
  pod: PodSummary | null;
  sessionId: string | null;
  error: InfraError | null;
  onError: (cause: unknown) => void;
  selectedPod: string;
  selectedContainer: string;
  setSelectedPod: (name: string) => void;
  setSelectedContainer: (name: string) => void;
  writeRef: RefObject<((text: string) => void) | null>;
  onConnect: (podName: string, container: string, cols: number, rows: number) => void;
  onDisconnect: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sessionRef = useRef(sessionId);
  const inputQueue = useRef("");
  sessionRef.current = sessionId;
  const targetPodName = selection.kind === "pod" ? selection.name : selectedPod || (relatedPods.length === 1 ? relatedPods[0].name : "");
  const targetPod = selection.kind === "pod" ? pod : relatedPods.find((item) => item.name === targetPodName);
  const containers = targetPod?.containers ?? [];
  const targetContainer = selectedContainer || (containers.length === 1 ? containers[0].name : "");

  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontSize: 12,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      scrollback: 3000,
      theme: { background: "#0d1110", foreground: "#d7e0dc", cursor: "#d3a96d", selectionBackground: "#46534c" },
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(host.current);
    fitAddon.fit();
    terminal.current = instance;
    fit.current = fitAddon;
    writeRef.current = (text) => instance.write(text);
    if (!sessionRef.current) instance.write("Select a target above and connect.\r\n");

    let flushTimer: number | undefined;
    const dataSubscription = instance.onData((data) => {
      if (!sessionRef.current) return;
      inputQueue.current += data;
      if (flushTimer !== undefined) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = undefined;
        const session = sessionRef.current;
        const input = inputQueue.current;
        inputQueue.current = "";
        if (session && input) void kubernetes.sendShellInput(session, input).catch(onError);
      }, 12);
    });
    instance.attachCustomKeyEventHandler((event) => {
      const isPasteShortcut = event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
      if (!isPasteShortcut) return true;
      event.preventDefault();
      const session = sessionRef.current;
      if (!session) {
        instance.writeln("\r\nConnect to a container before pasting.");
        return false;
      }
      if (!navigator.clipboard?.readText) {
        instance.writeln("\r\nClipboard access is unavailable in this WebView.");
        return false;
      }
      void navigator.clipboard.readText().then((text) => {
        if (sessionRef.current === session && text) instance.paste(text);
      }).catch(() => {
        instance.writeln("\r\nClipboard paste failed. Check clipboard access for Kubebs.");
      });
      return false;
    });
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const session = sessionRef.current;
      if (session) void kubernetes.resizeShell(session, instance.cols, instance.rows).catch(onError);
    });
    resizeObserver.observe(host.current);
    return () => {
      resizeObserver.disconnect();
      dataSubscription.dispose();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      inputQueue.current = "";
      writeRef.current = null;
      terminal.current = null;
      fit.current = null;
      instance.dispose();
    };
  }, [onError, writeRef]);

  useEffect(() => {
    if (sessionId) terminal.current?.focus();
  }, [sessionId]);

  const connect = () => {
    const instance = terminal.current;
    const fitAddon = fit.current;
    if (!instance || !fitAddon || !targetPodName || !targetContainer) return;
    fitAddon.fit();
    onConnect(targetPodName, targetContainer, instance.cols, instance.rows);
  };

  return <div className="shell-panel">
    <div className="shell-toolbar">
      {selection.kind === "deployment" && relatedPods.length > 1 && <select aria-label="Select Pod for shell" value={targetPodName} onChange={(event) => setSelectedPod(event.target.value)}><option value="">Choose Pod</option>{relatedPods.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>}
      {containers.length > 1 && <select aria-label="Select container for shell" value={targetContainer} onChange={(event) => setSelectedContainer(event.target.value)}><option value="">Choose container</option>{containers.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>}
      <span className="shell-target-label">{targetPodName || "No Pod selected"}{targetContainer ? ` · ${targetContainer}` : ""}</span>
      {!sessionId ? <button className="small-action" disabled={!targetPodName || !targetContainer} onClick={connect}>Connect</button> : <button className="small-action" onClick={onDisconnect}>Disconnect</button>}
    </div>
    {error && <div className="shell-error" role="alert"><strong>Could not open the container shell</strong><span>{error.message}</span></div>}
    {!targetPodName && selection.kind === "deployment" && relatedPods.length === 0 && <div className="shell-error" role="status">No related Pods are available for this Deployment.</div>}
    <div className="shell-terminal-host" ref={host} role="application" aria-label="Interactive container terminal" onClick={() => terminal.current?.focus()} />
  </div>;
}

function Property({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return <div className="property"><span>{label}</span><strong className={tone === "warning" ? "property-warning" : ""}>{value}</strong></div>;
}

function yamlTokenClass(line: string, index: number): string {
  const before = line.slice(0, index);
  if (/^\s*#/.test(line)) return "yaml-comment";
  if (/^\s*[-?]\s/.test(line) && index < line.search(/\S/)) return "yaml-punctuation";
  const colon = line.indexOf(":");
  if (colon >= 0 && index <= colon) return "yaml-key";
  if (line[index] === '"' || line[index] === "'") return "yaml-string";
  if (/\b(true|false|null|~)\b/i.test(line.slice(index)) && /^(true|false|null|~)\b/i.test(line.slice(index))) return "yaml-literal";
  if (/^-?\d/.test(line.slice(index)) && (index === 0 || /[:\s,[{]/.test(before.at(-1) ?? ""))) return "yaml-number";
  return "";
}

function YamlView({ yaml, copied, onCopy }: { yaml: string; copied: boolean; onCopy: (text: string) => void }) {
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const matches = useMemo(() => {
    if (!query) return [] as Array<{ line: number; start: number; end: number }>;
    const found: Array<{ line: number; start: number; end: number }> = [];
    yaml.split("\n").forEach((line, lineIndex) => {
      let start = 0;
      while ((start = line.toLowerCase().indexOf(query.toLowerCase(), start)) >= 0) {
        found.push({ line: lineIndex, start, end: start + query.length });
        start += Math.max(1, query.length);
      }
    });
    return found;
  }, [query, yaml]);
  const currentMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : -1;
  useEffect(() => {
    setActiveMatch(0);
  }, [query, yaml]);
  useEffect(() => {
    if (currentMatch < 0) return;
    document.querySelector(`[data-yaml-match="${currentMatch}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentMatch]);
  const lines = yaml.split("\n");
  return <div className="code-panel">
    <div className="code-toolbar"><span><FileCode2 size={14} /> Resource manifest</span>
      <label className="yaml-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in YAML" aria-label="Search YAML" /></label>
      <span className="yaml-match-count" aria-live="polite">{query ? `${matches.length ? currentMatch + 1 : 0} / ${matches.length}` : ""}</span>
      <button className="small-action" disabled={!matches.length} aria-label="Previous YAML match" onClick={() => setActiveMatch((value) => (value - 1 + matches.length) % matches.length)}>↑</button>
      <button className="small-action" disabled={!matches.length} aria-label="Next YAML match" onClick={() => setActiveMatch((value) => (value + 1) % matches.length)}>↓</button>
      <button className="small-action" onClick={() => void onCopy(yaml)}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button>
    </div>
    {query && matches.length === 0 && <div className="yaml-no-match">No matches for “{query}”.</div>}
    <pre className="yaml-content">{lines.map((line, lineIndex) => {
      const lineMatches = matches.map((match, index) => ({ ...match, index })).filter((match) => match.line === lineIndex);
      const points = new Set<number>([0, line.length]);
      lineMatches.forEach((match) => { points.add(match.start); points.add(match.end); });
      const ordered = [...points].sort((a, b) => a - b);
      return <span className="yaml-line" key={lineIndex}>{ordered.slice(0, -1).map((start, segmentIndex) => {
        const end = ordered[segmentIndex + 1];
        const match = lineMatches.find((item) => start >= item.start && start < item.end);
        const tokenClass = yamlTokenClass(line, start);
        const value = line.slice(start, end);
        return match ? <mark className={match.index === currentMatch ? "yaml-match yaml-match-current" : "yaml-match"} data-yaml-match={match.index} key={`${start}-${end}`}>{value}</mark> : <span className={tokenClass} key={`${start}-${end}`}>{value}</span>;
      })}{lineIndex < lines.length - 1 ? "\n" : ""}</span>;
    })}</pre>
  </div>;
}

function cleanLogLine(line: string, showKubernetesTimestamp: boolean): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const withoutAnsi = line.replace(ansiPattern, "");
  if (showKubernetesTimestamp) return withoutAnsi;
  return withoutAnsi.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, "");
}

function LogsView({
  selection,
  pod,
  relatedPods,
  logPodName,
  setLogPodName,
  logContainer,
  setLogContainer,
  logs,
  logSearch,
  setLogSearch,
  showLogTimestamps,
  setShowLogTimestamps,
  paused,
  logPane,
  error,
  onToggleLogs,
}: {
  selection: Selection;
  pod: PodSummary | null;
  relatedPods: PodSummary[];
  logPodName: string;
  setLogPodName: (name: string) => void;
  logContainer: string;
  setLogContainer: (container: string) => void;
  logs: string[];
  logSearch: string;
  setLogSearch: (query: string) => void;
  showLogTimestamps: boolean;
  setShowLogTimestamps: Dispatch<SetStateAction<boolean>>;
  paused: boolean;
  logPane: RefObject<HTMLDivElement | null>;
  error: InfraError | null;
  onToggleLogs: () => void;
}) {
  const targetPod = selection.kind === "pod" ? pod : relatedPods.find((item) => item.name === logPodName) ?? relatedPods[0];
  const containers = targetPod?.containers ?? [];
  useEffect(() => {
    if (targetPod && !targetPod.containers.some((container) => container.name === logContainer)) {
      setLogContainer(targetPod.containers[0]?.name ?? "");
    }
  }, [logContainer, targetPod, setLogContainer]);
  const visibleLines = logs.map((line) => cleanLogLine(line, showLogTimestamps)).filter((line) => !logSearch || line.toLowerCase().includes(logSearch.toLowerCase()));

  if (!targetPod) return <EmptyState title="No Pod to stream" message="No related Pods." />;
  return <div className="logs-panel">
    <div className="logs-toolbar">
      <span className="live-label"><span />{paused ? "Paused" : "Live"}</span>
      {selection.kind !== "pod" && relatedPods.length > 0 && <DropdownMenu className="log-container-picker log-pod-picker" ariaLabel="Log Pod" value={targetPod.name} options={relatedPods.map((item) => ({ value: item.name, label: item.name }))} onChange={(name) => { setLogPodName(name); setLogContainer(""); }} />}
      {containers.length > 1 && <DropdownMenu className="log-container-picker" ariaLabel="Log container" value={logContainer} options={containers.map((container) => ({ value: container.name, label: container.name }))} onChange={setLogContainer} />}
      <label className="log-search"><Search size={12} /><input value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="Find in logs" aria-label="Search logs" /></label>
      <button className={`timestamp-toggle ${showLogTimestamps ? "timestamp-active" : ""}`} onClick={() => setShowLogTimestamps((value) => !value)} aria-pressed={showLogTimestamps} title="Toggle Kubernetes timestamps">TS</button>
      <span className="logs-latest-label">Last 300 + live</span>
      <button className="small-action" onClick={onToggleLogs}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? "Resume" : "Pause"}</button>
    </div>
    {error && <InlineError error={error} onRetry={onToggleLogs} />}
    {logs.length === 0 ? <div className="logs-empty"><LoaderCircle size={16} className="spin" /><span>{paused ? "Stream paused" : `Waiting for ${logContainer || "container"} output`}</span></div> : visibleLines.length === 0 ? <div className="logs-empty"><Search size={15} /><span>No lines match this search.</span></div> : <div className="logs-content" ref={logPane}>{visibleLines.map((line, index) => {
      const podPrefix = line.match(/^\[([^\]]+)\](.*)$/);
      return <div className="log-line" key={`${index}-${line}`} title={line}>
        {podPrefix ? <><span className="log-pod-name">[{podPrefix[1]}]</span><span>{podPrefix[2]}</span></> : <span>{line}</span>}
      </div>;
    })}</div>}
  </div>;
}

function RelatedPods({ pods, error, onRetry, onResource }: { pods: PodSummary[]; error: InfraError | null; onRetry: () => void; onResource: (kind: Kind, name: string, namespace: string) => void }) {
  if (error) return <div className="partial-error"><InlineError error={error} onRetry={onRetry} /></div>;
  if (pods.length === 0) return <EmptyState title="No related Pods" message="No Pods match this resource's selector." />;
  return <div className="related-list"><div className="trace-rail" aria-hidden="true" />{pods.map((pod) => <button className="related-pod" key={`${pod.namespace}-${pod.name}`} onClick={() => onResource("pod", pod.name, pod.namespace)}><span className={`resource-state ${podHealthy(pod) ? "resource-state-good" : "resource-state-bad"}`} /><div><strong>{pod.name}</strong><span>{pod.namespace} · {pod.readyContainers}/{pod.totalContainers} ready</span></div><span className={`status-text status-${statusTone(pod.status)}`}>{pod.status}</span><ChevronRight size={14} /></button>)}</div>;
}

function EventList({ events, error, onRetry }: { events: EventSummary[]; error: InfraError | null; onRetry: () => void }) {
  if (error) return <div className="partial-error"><InlineError error={error} onRetry={onRetry} /></div>;
  if (events.length === 0) return <EmptyState title="No related events" message="Kubernetes has not reported events for this resource." />;
  return <div className="event-list">{events.map((event) => <article key={`${event.namespace}-${event.name}`} className={`event-item ${event.eventType.toLowerCase() === "warning" ? "event-warning" : ""}`}><div className="event-line"><span className={`event-type event-${event.eventType.toLowerCase()}`}>{event.eventType}</span><strong>{event.reason}</strong><time>{formatAge(event.lastSeen)}</time></div><p>{event.message}</p><span className="event-object">{event.objectKind.toLowerCase()}/{event.objectName}</span></article>)}</div>;
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`loading-state ${compact ? "loading-compact" : ""}`} role="status"><LoaderCircle size={16} className="spin" /><span>{label}</span></div>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return <div className="empty-state"><span className="empty-mark"><Search size={16} /></span><strong>{title}</strong><p>{message}</p></div>;
}

function InlineError({ error, onRetry }: { error: InfraError | null; onRetry: () => void }) {
  return <div className="inline-error" role="alert"><AlertCircle size={16} /><div><strong>{error?.kind === "permission_denied" ? "Access denied" : error?.kind === "authentication" ? "Credentials rejected" : "Could not load cluster data"}</strong><span>{error?.message ?? "The request failed. Try again."}</span></div><button onClick={onRetry}>Retry</button></div>;
}
