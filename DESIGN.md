# Kubebs design direction

## Product read

Kubebs is a Windows-first Kubernetes desktop client for operators investigating cluster health. Its primary job is to take an operator from a workload that needs attention to the resource details and evidence behind its state.

**Reading:** Native-feeling Windows utility for Kubernetes operators, using Windows 11 Fluent interaction conventions with restrained, spacious desktop composition. ENERGY 1 / RHYTHM 2 / MOTION 1.

## Design principles

- **Desktop before web:** use one integrated title/action strip that shares the workspace surface, with proper Windows drag, resize, minimize, maximize and close behavior. Avoid a separate branded header above a second toolbar.
- **Investigation is the identity:** make the needs-attention queue and the path from a workload to its Pods, events, logs and manifest the distinctive composition. Counts support that task; they are not a decorative KPI strip.
- **Gold accent:** use muted gold consistently for brand, selection and keyboard focus. Keep light/dark surface adaptation and reserve green, amber, red and blue only for real health and metric data.
- **Legibility at working distance:** Segoe UI Variable is the interface face because it is the native Windows UI family. Cascadia Code, falling back to Consolas, is reserved for logs, shell and exact technical identifiers. Do not use tiny caption text as a density trick.
- **Quiet controls:** selection, focus, hover, open menus and destructive-action confirmation must be clear and keyboard-accessible. A status mark appears only when it communicates actual state. Scrollbar arrows stay suppressed, with the thumb revealed only while its region is hovered or focused.
- **Sidebar island:** keep the sidebar inset as a softly bounded island in both expanded and collapsed states; the collapsed state becomes an icon rail without losing the outer gutter.
- **Motion:** MOTION 1. Use brief state transitions and hover/focus feedback only. Respect reduced-motion preference; no ambient or looping animation.

## Palette tokens

Use these as semantic references, not a fixed brand skin. Where available, Windows system colors take precedence so the app follows user personalization.

| Role | Reference | Use |
| --- | --- | --- |
| Window canvas | `#F3F3F3` / `#202020` | Light / dark work area |
| Primary surface | `#FFFFFF` / `#2B2B2B` | Main pane and focused content |
| Secondary surface | `#F7F7F7` / `#252525` | Sidebar, toolbars and grouped regions |
| Divider | `#E5E5E5` / `#3A3A3A` | Structural boundaries only |
| Primary text | `#1A1A1A` / `#F5F5F5` | Content and controls |
| Muted text | `#5C5C5C` / `#B8B8B8` | Supporting information, with readable contrast |
| Accent | Windows `AccentColor` | Current selection and keyboard focus, used sparingly |
| Health semantics | Green / amber / red | Real resource state only; never decoration |

In CSS, express theme-dependent references with semantic variables and `light-dark()` or platform system colors. Do not scatter new literal colors through component rules. Verify text contrast in both schemes.

## Composition

The persistent workspace has an inset navigation island, one integrated title/action strip, and a main investigation surface. The title strip carries the app identity, current section/resource breadcrumb, cluster actions and window controls in a single row, with no rule separating it from the workspace. The sidebar keeps its island shape in both expanded and collapsed states; collapse turns it into an icon rail with a top-anchored icon-only toggle and tooltips. The resource detail pane is also inset as an island, including expanded and narrow layouts. Revision history shows an exact local date and time, including seconds and the local timezone, and hides revisions whose full container image set matches the current deployment. Restart and restore use an in-app, keyboard-dismissable confirmation dialog. Keep resource browsing table-first; selected-resource details remain a contextual pane. On the overview, give the investigation queue the strongest content hierarchy, with deployment status as supporting context and summary values subordinate.

```text
┌ Integrated title/actions · Kubebs · section/resource · window controls┐
│ Context / navigation │ Cluster context and actual connection state  │
│                      ├───────────────────────────────────────────────┤
│ Overview             │                                               │
│ Workloads            │                                             │
│ Network              │ Needs attention      Deployments            │
│ Nodes                │ [problem → inspect]  [real resource rows]   │
│                      │                                             │
│                      │ Counts are quiet supporting context         │
└──────────────────────┴───────────────────────────────────────────────┘
```

## Audit-driven implementation guidance

1. Use Tauri's undecorated window with one integrated app title/action strip. Preserve native-feeling drag, resizing and caption controls, and do not split the toolbar into a separate header row or divider.
2. Raise the pervasive 7–11px interface type and control sizing to readable Windows desktop defaults. Keep dense monospace output as a deliberate exception, with user-resizable or otherwise legible technical views.
3. Use a muted gold accent consistently in light and dark appearance; preserve semantic status and CPU/memory colors only where the displayed data requires them.
4. Reduce the visual priority of the equal-weight three-metric strip and prioritize actionable workload investigation. Avoid decorative left stripes, unnecessary uppercase labels and redundant status badges.
5. Keep real status indicators and meaningful icons, but remove icon-only decoration where a clear text label is better. Ensure keyboard focus is visible and controls retain real behavior.
6. Verify the icon-rail collapse/expand behavior, smallest supported desktop window, light/dark system appearance, keyboard use, reduced motion and all existing resource/detail flows. Preserve the existing Kubernetes functionality.

## Decision notes

- A single integrated title/action strip makes window chrome and workspace controls read as one desktop surface; custom caption controls are needed because the window is undecorated.
- Segoe UI Variable is chosen for Windows familiarity and legibility; Cascadia Code is limited to technical strings because exact character alignment helps scan and copy them.
- The workload investigation queue is the signature because it expresses Kubebs' actual operator task rather than borrowing a generic dashboard motif.
- Gold carries the product's identity and its selected/focus states; semantic colors carry actual cluster and metric meaning.
- RHYTHM 2 preserves predictable navigation and tables while allowing the overview to give the investigation queue a distinct composition.
